// Trading bots. Each agent is an ordinary user of the public API: it registers, deposits and
// trades over HTTP exactly as the terminal does. There is no back door to the engine, so a
// bot can only do what a person could, and every order it sends goes through the same
// validation, rate limit, reservation and settlement as a person's.

import { ApiClient, type MarketInfo, units } from "./client.ts";
import {
  cancelAll,
  equity,
  LossLimit,
  RiskGuard,
  type RiskLimits,
  type TradingApi,
} from "./risk.ts";

export type Logger = (event: string, fields?: Record<string, unknown>) => void;

// One JSON line per event, so a fleet's output can be filtered with jq.
export const jsonLog: Logger = (event, fields = {}) => {
  console.log(JSON.stringify({ time: new Date().toISOString(), event, ...fields }));
};

export type AgentContext = {
  name: string;
  api: TradingApi;
  market: MarketInfo;
  // In [0, 1). Injected so a test can make a strategy's choices repeatable.
  random: () => number;
  log: Logger;
};

// What an agent does on each tick. The runner owns the timing and the account.
export type Strategy = { tick(context: AgentContext): Promise<void> };

export type AgentLimits = RiskLimits & {
  // Failed ticks in a row that trip the kill switch: an agent that keeps failing is not
  // trading on what it thinks it is.
  maxFailedTicks: number;
};

export type AgentSpec = {
  name: string;
  email: string;
  market: string;
  // Decimal amounts per asset. At start the account is topped up to these totals, available
  // plus reserved, so a restart does not keep adding money.
  funding: Record<string, string>;
  intervalMs: number;
  strategy: Strategy;
  limits: AgentLimits;
};

// Stopped is the operator's choice; killed is the kill switch's. Both end with nothing resting.
export type AgentStatus = "running" | "stopping" | "stopped" | "killed";

// One running agent. Ticks are chained with setTimeout rather than setInterval, so a slow
// tick delays the next one instead of overlapping it: one agent never races itself.
export class Agent {
  readonly name: string;
  readonly #api: TradingApi;
  readonly #guard: RiskGuard;
  readonly #context: AgentContext;
  readonly #spec: AgentSpec;
  #status: AgentStatus = "running";
  #timer: NodeJS.Timeout | undefined;
  #running: Promise<void> = Promise.resolve();
  #failedInARow = 0;
  readonly #loss: LossLimit;
  ticks = 0;
  failedTicks = 0;
  killReason: string | undefined;

  constructor(
    spec: AgentSpec,
    api: TradingApi,
    context: Omit<AgentContext, "api">,
    startInventory: bigint,
    startEquity: bigint | undefined,
  ) {
    this.name = spec.name;
    this.#spec = spec;
    this.#api = api;
    this.#guard = new RiskGuard(api, context.market, spec.limits, startInventory);
    this.#context = { ...context, api: this.#guard };
    this.#loss = new LossLimit(spec.limits.maxLoss, startEquity);
  }

  get status(): AgentStatus {
    return this.#status;
  }

  get context(): AgentContext {
    return this.#context;
  }

  get riskRefusals(): number {
    return this.#guard.refusals;
  }

  schedule(): void {
    if (this.#status !== "running") {
      return;
    }
    // Up to half an interval of jitter, so a fleet started together does not tick together.
    const delay = this.#spec.intervalMs * (0.75 + this.#context.random() / 2);
    this.#timer = setTimeout(() => {
      this.#running = this.#tick().finally(() => this.schedule());
    }, delay);
  }

  async #tick(): Promise<void> {
    try {
      await this.#spec.strategy.tick(this.#context);
      await this.#checkLoss();
      this.ticks += 1;
      this.#failedInARow = 0;
    } catch (error) {
      // One failed tick (the API restarting, a timeout) should not end the agent; the next
      // tick starts from fresh API reads. Too many in a row trips the kill switch.
      this.failedTicks += 1;
      this.#failedInARow += 1;
      this.#context.log("tick_failed", { agent: this.name, error: String(error) });
      if (this.#failedInARow >= this.#spec.limits.maxFailedTicks) {
        await this.#halt("killed", `${this.#failedInARow} failed ticks in a row`);
      }
    }
  }

  async #checkLoss(): Promise<void> {
    const breach = await this.#loss.breach(this.#api, this.#context.market);
    if (breach !== undefined && this.#status === "running") {
      await this.#halt("killed", breach);
    }
  }

  // The kill switch from outside: an operator or a fleet-wide breach. Waits for the tick in
  // flight, which the guard already refuses to let place anything more.
  async kill(reason: string): Promise<void> {
    if (this.#status !== "running") {
      return;
    }
    this.#guard.killed = true;
    await this.#running;
    await this.#halt("killed", reason);
  }

  // Waits for the tick in flight, then cancels whatever the agent still has resting, so a
  // stopped bot leaves no orders in the book holding its funds.
  async stop(): Promise<void> {
    if (this.#status !== "running") {
      return;
    }
    this.#status = "stopping";
    await this.#running;
    await this.#halt("stopped", "stopped");
  }

  // Called from inside a tick by the kill switch, so it must not wait for #running, which is
  // that same tick.
  async #halt(status: "stopped" | "killed", reason: string): Promise<void> {
    if (this.#status === "stopped" || this.#status === "killed") {
      return;
    }
    // Status and reason change together, before the cancels, so anyone who sees "killed"
    // also sees why.
    this.#status = status;
    if (status === "killed") {
      this.killReason = reason;
    }
    this.#guard.killed = true;
    clearTimeout(this.#timer);
    const { market, log } = this.#context;
    const cancelled = await cancelAll(this.#api, market);
    if (status === "killed") {
      log("agent_killed", { agent: this.name, reason, cancelled });
    } else {
      log("agent_stopped", { agent: this.name, ticks: this.ticks, cancelled });
    }
  }
}

export type RunnerOptions = {
  baseUrl: string;
  password: string;
  random?: () => number;
  log?: Logger;
  // How each agent's client is made. Tests swap in one with a fixed last price.
  client?: (baseUrl: string, email: string, password: string) => ApiClient;
};

export class AgentRunner {
  readonly #options: Required<RunnerOptions>;
  readonly agents: Agent[] = [];

  constructor(options: RunnerOptions) {
    this.#options = {
      random: Math.random,
      log: jsonLog,
      client: (baseUrl, email, password) => new ApiClient(baseUrl, email, password),
      ...options,
    };
  }

  // Signs the agent in (registering it the first time), tops up its funding and starts it.
  async start(spec: AgentSpec): Promise<Agent> {
    const { baseUrl, password, random, log, client } = this.#options;
    const api = client(baseUrl, spec.email, password);
    await api.signIn();
    const market = await api.market(spec.market);
    await topUp(api, market, spec.funding);

    // Limits are measured from where the agent starts this run, after its top-up.
    const held = (await api.balances()).get(market.baseAsset);
    const inventory = held === undefined ? 0n : held.available + held.reserved;
    const startEquity = await equity(api, market);
    const context = { name: spec.name, market, random, log };
    const agent = new Agent(spec, api, context, inventory, startEquity);
    this.agents.push(agent);
    agent.schedule();
    log("agent_started", { agent: spec.name, market: spec.market });
    return agent;
  }

  async stopAll(): Promise<void> {
    await Promise.all(this.agents.map((agent) => agent.stop()));
  }

  // The fleet-wide kill switch.
  async killAll(reason: string): Promise<void> {
    await Promise.all(this.agents.map((agent) => agent.kill(reason)));
  }
}

async function topUp(
  api: ApiClient,
  market: MarketInfo,
  funding: Record<string, string>,
): Promise<void> {
  const balances = await api.balances();
  for (const [asset, amount] of Object.entries(funding)) {
    const scale =
      asset === market.baseAsset
        ? market.baseScale
        : asset === market.quoteAsset
          ? market.quoteScale
          : undefined;
    if (scale === undefined) {
      throw new Error(`funding ${asset} is not traded in ${market.symbol}`);
    }
    const target = units(amount, scale);
    const held = balances.get(asset);
    const total = held === undefined ? 0n : held.available + held.reserved;
    if (total < target) {
      await api.deposit(asset, target - total, scale);
    }
  }
}
