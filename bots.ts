// Trading bots. Each agent is an ordinary user of the public API: it registers, deposits and
// trades over HTTP exactly as the terminal does. There is no back door to the engine, so a
// bot can only do what a person could, and every order it sends goes through the same
// validation, rate limit, reservation and settlement as a person's.

import {
  ApiClient,
  type MarketInfo,
  type OrderRequest,
  type PlaceResult,
  type Side,
  units,
} from "./client.ts";

export type Logger = (event: string, fields?: Record<string, unknown>) => void;

// One JSON line per event, so a fleet's output can be filtered with jq.
export const jsonLog: Logger = (event, fields = {}) => {
  console.log(JSON.stringify({ time: new Date().toISOString(), event, ...fields }));
};

// What a strategy may call. On a running agent it is the agent's RiskGuard, not the client.
export type TradingApi = Pick<
  ApiClient,
  "balances" | "openOrders" | "lastPrice" | "markPrice" | "place" | "cancel"
>;

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

// Hard limits, enforced outside the strategy so a strategy bug cannot trade past them. The
// strategies have soft limits of their own (the maker's inventory cap, the noise trader's
// resting cap); these are the backstop.
export type RiskLimits = {
  // The largest base quantity one order may ask for.
  maxOrderQuantity: bigint;
  // Resting orders the agent may have at once.
  maxOpenOrders: number;
  // How far base inventory may move from where it started, counting every resting order on
  // that side as if it had filled, so no sequence of fills can pass it.
  maxPosition: bigint;
  // A fall in equity since start, in quote minor units, that trips the kill switch. Equity is
  // the quote balance plus the base balance valued at the mark (see markFrom).
  maxLoss: bigint;
  // Failed ticks in a row that trip it: an agent that keeps failing is not trading on what
  // it thinks it is.
  maxFailedTicks: number;
};

export type RiskRefusal = "max_order_quantity" | "max_open_orders" | "max_position" | "killed";

// Pre-trade checks. Every order a strategy places goes through place(), which reads the
// agent's open orders and balances and refuses, without sending anything, an order that
// would break a limit. Reads and cancels pass straight through: cancelling only lowers risk.
export class RiskGuard implements TradingApi {
  readonly #api: TradingApi;
  readonly #market: MarketInfo;
  readonly #limits: RiskLimits;
  readonly #startInventory: bigint;
  killed = false;
  refusals = 0;

  constructor(api: TradingApi, market: MarketInfo, limits: RiskLimits, startInventory: bigint) {
    this.#api = api;
    this.#market = market;
    this.#limits = limits;
    this.#startInventory = startInventory;
  }

  balances() {
    return this.#api.balances();
  }

  openOrders(market: MarketInfo) {
    return this.#api.openOrders(market);
  }

  lastPrice(market: MarketInfo) {
    return this.#api.lastPrice(market);
  }

  markPrice(market: MarketInfo) {
    return this.#api.markPrice(market);
  }

  cancel(orderId: string) {
    return this.#api.cancel(orderId);
  }

  async place(market: MarketInfo, order: OrderRequest): Promise<PlaceResult> {
    if (market.symbol !== this.#market.symbol) {
      throw new Error(`agent trades ${this.#market.symbol}, not ${market.symbol}`);
    }
    const refusal = await this.check(order);
    if (refusal !== undefined) {
      this.refusals += 1;
      return { ok: false, status: 0, error: `risk_${refusal}` };
    }
    return this.#api.place(market, order);
  }

  async check(order: OrderRequest): Promise<RiskRefusal | undefined> {
    const limits = this.#limits;
    if (this.killed) {
      return "killed";
    }
    if (order.quantity > limits.maxOrderQuantity) {
      return "max_order_quantity";
    }
    const [open, balances] = await Promise.all([
      this.#api.openOrders(this.#market),
      this.#api.balances(),
    ]);
    // Checked again after the reads: the kill switch may have tripped while they ran.
    if (this.killed) {
      return "killed";
    }
    if (open.length >= limits.maxOpenOrders) {
      return "max_open_orders";
    }
    const held = balances.get(this.#market.baseAsset);
    const inventory = held === undefined ? 0n : held.available + held.reserved;
    const remaining = (side: Side) =>
      open
        .filter((resting) => resting.side === side)
        .reduce((total, resting) => total + resting.quantity - resting.filled, 0n);
    const highest = inventory + remaining("buy") + (order.side === "buy" ? order.quantity : 0n);
    const lowest = inventory - remaining("sell") - (order.side === "sell" ? order.quantity : 0n);
    if (
      highest - this.#startInventory > limits.maxPosition ||
      this.#startInventory - lowest > limits.maxPosition
    ) {
      return "max_position";
    }
    return undefined;
  }
}

// Quote balance plus base valued at the mark, in quote minor units, or undefined before the
// market's first trade. Rounded down: it feeds a limit, not the ledger.
export async function equity(api: TradingApi, market: MarketInfo): Promise<bigint | undefined> {
  const [balances, price] = await Promise.all([api.balances(), api.markPrice(market)]);
  if (price === undefined) {
    return undefined;
  }
  const total = (asset: string) => {
    const held = balances.get(asset);
    return held === undefined ? 0n : held.available + held.reserved;
  };
  return (
    total(market.quoteAsset) + (total(market.baseAsset) * price) / 10n ** BigInt(market.baseScale)
  );
}

export type AgentSpec = {
  name: string;
  email: string;
  market: string;
  // Decimal amounts per asset. At start the account is topped up to these totals, available
  // plus reserved, so a restart does not keep adding money.
  funding: Record<string, string>;
  intervalMs: number;
  strategy: Strategy;
  limits: RiskLimits;
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
  #startEquity: bigint | undefined;
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
    this.#startEquity = startEquity;
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
    const now = await equity(this.#api, this.#context.market);
    if (now === undefined || this.#status !== "running") {
      return;
    }
    // Before the market's first trade there is no price to value base at, so the baseline is
    // the first equity the agent can measure.
    this.#startEquity ??= now;
    const loss = this.#startEquity - now;
    if (loss > this.#spec.limits.maxLoss) {
      await this.#halt(
        "killed",
        `lost ${loss} quote minor units, limit ${this.#spec.limits.maxLoss}`,
      );
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
    const open = await this.#api.openOrders(market);
    for (const order of open) {
      await this.#api.cancel(order.id);
    }
    if (status === "killed") {
      log("agent_killed", { agent: this.name, reason, cancelled: open.length });
    } else {
      log("agent_stopped", { agent: this.name, ticks: this.ticks, cancelled: open.length });
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
