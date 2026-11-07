// Trading bots. Each agent is an ordinary user of the public API: it registers, deposits and
// trades over HTTP exactly as the terminal does. There is no back door to the engine, so a
// bot can only do what a person could, and every order it sends goes through the same
// validation, rate limit, reservation and settlement as a person's.

import { z } from "zod";
import { formatAmount, parseAmount } from "./money.ts";

export type Side = "buy" | "sell";

// A market's grid in minor units, from GET /markets.
export type MarketInfo = {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  baseScale: number;
  quoteScale: number;
  tickSize: bigint;
  quantityStep: bigint;
  minQuantity: bigint;
};

export type Balance = { available: bigint; reserved: bigint };

export type OrderRequest =
  | { type: "limit"; side: Side; price: bigint; quantity: bigint }
  | { type: "market"; side: Side; quantity: bigint };

export type PlaceResult =
  | { ok: true; id: string; status: string; filled: bigint }
  // The API's own error code (insufficient_funds, rate_limited, market_busy, ...), so a
  // strategy can tell a refusal it should expect from a bug. Status 0 means the risk guard
  // refused it and nothing was sent.
  | { ok: false; status: number; error: string };

export type OpenOrder = {
  id: string;
  side: Side;
  price: bigint | null;
  quantity: bigint;
  filled: bigint;
};

export type Logger = (event: string, fields?: Record<string, unknown>) => void;

// One JSON line per event, so a fleet's output can be filtered with jq.
export const jsonLog: Logger = (event, fields = {}) => {
  console.log(JSON.stringify({ time: new Date().toISOString(), event, ...fields }));
};

// The API prints every amount at its asset's full scale, so the number of decimals in any
// one amount is that asset's scale.
function scaleOf(amount: string): number {
  return amount.split(".")[1]?.length ?? 0;
}

function units(amount: string, scale: number): bigint {
  const parsed = parseAmount(amount, scale);
  if (!parsed.ok) {
    throw new Error(`the API sent an amount the bot cannot read: ${amount} (${parsed.reason})`);
  }
  return parsed.units;
}

// Only the fields a bot reads. Anything else in a response is ignored.
const marketsReply = z.object({
  markets: z.array(
    z.object({
      symbol: z.string(),
      baseAsset: z.string(),
      quoteAsset: z.string(),
      tickSize: z.string(),
      quantityStep: z.string(),
      minQuantity: z.string(),
    }),
  ),
});
const loginReply = z.object({ accessToken: z.string() });
const errorReply = z.object({ error: z.string() });
const balancesReply = z.object({
  balances: z.array(z.object({ asset: z.string(), available: z.string(), reserved: z.string() })),
});
const placedReply = z.object({ id: z.string(), status: z.string(), filledQuantity: z.string() });
const ordersReply = z.object({
  orders: z.array(
    z.object({
      id: z.string(),
      side: z.enum(["buy", "sell"]),
      price: z.string().nullable(),
      quantity: z.string(),
      filledQuantity: z.string(),
    }),
  ),
});
const tradesReply = z.object({ trades: z.array(z.object({ price: z.string() })) });

export class ApiError extends Error {
  readonly status: number;

  constructor(method: string, path: string, status: number, body: unknown) {
    super(`${method} ${path} answered ${status}: ${JSON.stringify(body)}`);
    this.name = "ApiError";
    this.status = status;
  }
}

// One agent's session with the API. It keeps the agent's password so that when the
// 15-minute access token expires it can sign in again instead of handling refresh cookies.
export class ApiClient {
  readonly #baseUrl: string;
  readonly #email: string;
  readonly #password: string;
  #token: string | undefined;

  constructor(baseUrl: string, email: string, password: string) {
    this.#baseUrl = baseUrl.replace(/\/$/, "");
    this.#email = email;
    this.#password = password;
  }

  // Registers the account the first time and signs in to it every time after, so restarting
  // a fleet reuses each agent's account and balances.
  async signIn(): Promise<void> {
    const credentials = { email: this.#email, password: this.#password };
    const registered = await this.#send("POST", "/register", credentials, false);
    if (registered.status !== 201 && registered.status !== 409) {
      throw new ApiError("POST", "/register", registered.status, registered.body);
    }
    await this.#login();
  }

  async #login(): Promise<void> {
    const reply = await this.#send(
      "POST",
      "/login",
      { email: this.#email, password: this.#password },
      false,
    );
    if (reply.status !== 200) {
      throw new ApiError("POST", "/login", reply.status, reply.body);
    }
    this.#token = loginReply.parse(reply.body).accessToken;
  }

  async #send(method: string, path: string, body: unknown, authenticated: boolean) {
    const headers: Record<string, string> = {};
    if (body !== undefined) {
      headers["content-type"] = "application/json";
    }
    if (authenticated && this.#token !== undefined) {
      headers.authorization = `Bearer ${this.#token}`;
    }
    const response = await fetch(`${this.#baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return {
      status: response.status,
      body: text === "" ? undefined : (JSON.parse(text) as unknown),
    };
  }

  // An authenticated request. A 401 means the token expired, so sign in and try once more.
  async #call(method: string, path: string, body?: unknown) {
    if (this.#token === undefined) {
      await this.#login();
    }
    const reply = await this.#send(method, path, body, true);
    if (reply.status !== 401) {
      return reply;
    }
    await this.#login();
    return this.#send(method, path, body, true);
  }

  async #expect(method: string, path: string, status: number, body?: unknown): Promise<unknown> {
    const reply = await this.#call(method, path, body);
    if (reply.status !== status) {
      throw new ApiError(method, path, reply.status, reply.body);
    }
    return reply.body;
  }

  async market(symbol: string): Promise<MarketInfo> {
    const reply = await this.#send("GET", "/markets", undefined, false);
    if (reply.status !== 200) {
      throw new ApiError("GET", "/markets", reply.status, reply.body);
    }
    const listed = marketsReply.parse(reply.body).markets.find((m) => m.symbol === symbol);
    if (listed === undefined) {
      throw new Error(`market ${symbol} is not listed`);
    }
    const quoteScale = scaleOf(listed.tickSize);
    const baseScale = scaleOf(listed.quantityStep);
    return {
      symbol,
      baseAsset: listed.baseAsset,
      quoteAsset: listed.quoteAsset,
      baseScale,
      quoteScale,
      tickSize: units(listed.tickSize, quoteScale),
      quantityStep: units(listed.quantityStep, baseScale),
      minQuantity: units(listed.minQuantity, baseScale),
    };
  }

  // Keyed by asset. The scale comes from the amount, as with markets.
  async balances(): Promise<Map<string, Balance>> {
    const body = balancesReply.parse(await this.#expect("GET", "/balances", 200));
    return new Map(
      body.balances.map((b) => [
        b.asset,
        {
          available: units(b.available, scaleOf(b.available)),
          reserved: units(b.reserved, scaleOf(b.reserved)),
        },
      ]),
    );
  }

  async deposit(asset: string, amount: bigint, scale: number): Promise<void> {
    await this.#expect("POST", "/deposits", 201, { asset, amount: formatAmount(amount, scale) });
  }

  async place(market: MarketInfo, order: OrderRequest): Promise<PlaceResult> {
    const reply = await this.#call("POST", "/orders", {
      market: market.symbol,
      side: order.side,
      type: order.type,
      quantity: formatAmount(order.quantity, market.baseScale),
      ...(order.type === "limit" ? { price: formatAmount(order.price, market.quoteScale) } : {}),
    });
    if (reply.status === 201) {
      const placed = placedReply.parse(reply.body);
      return {
        ok: true,
        id: placed.id,
        status: placed.status,
        filled: units(placed.filledQuantity, market.baseScale),
      };
    }
    // 400 means the bot built a bad order, which is a bug, not a market condition.
    if (reply.status === 400 || reply.status === 401) {
      throw new ApiError("POST", "/orders", reply.status, reply.body);
    }
    const parsed = errorReply.safeParse(reply.body);
    return {
      ok: false,
      status: reply.status,
      error: parsed.success ? parsed.data.error : "unknown",
    };
  }

  // True if this call cancelled it; false if it had already filled or been cancelled.
  async cancel(orderId: string): Promise<boolean> {
    const reply = await this.#call("DELETE", `/orders/${orderId}`);
    if (reply.status === 200) {
      return true;
    }
    if (reply.status === 409) {
      return false;
    }
    throw new ApiError("DELETE", `/orders/${orderId}`, reply.status, reply.body);
  }

  async openOrders(market: MarketInfo): Promise<OpenOrder[]> {
    const path = `/orders?status=open&market=${encodeURIComponent(market.symbol)}&limit=500`;
    const body = ordersReply.parse(await this.#expect("GET", path, 200));
    return body.orders.map((order) => ({
      id: order.id,
      side: order.side,
      price: order.price === null ? null : units(order.price, market.quoteScale),
      quantity: units(order.quantity, market.baseScale),
      filled: units(order.filledQuantity, market.baseScale),
    }));
  }

  // The price of the market's latest trade, or undefined before its first.
  async lastPrice(market: MarketInfo): Promise<bigint | undefined> {
    const path = `/markets/${encodeURIComponent(market.symbol)}/trades?limit=1`;
    const reply = await this.#send("GET", path, undefined, false);
    if (reply.status !== 200) {
      throw new ApiError("GET", path, reply.status, reply.body);
    }
    const [latest] = tradesReply.parse(reply.body).trades;
    return latest === undefined ? undefined : units(latest.price, market.quoteScale);
  }
}

// What a strategy may call. On a running agent it is the agent's RiskGuard, not the client.
export type TradingApi = Pick<
  ApiClient,
  "balances" | "openOrders" | "lastPrice" | "place" | "cancel"
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
  // the quote balance plus the base balance valued at the last trade.
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

// Quote balance plus base valued at the last trade, in quote minor units, or undefined before
// the market's first trade. Rounded down: it feeds a limit, not the ledger.
export async function equity(api: TradingApi, market: MarketInfo): Promise<bigint | undefined> {
  const [balances, price] = await Promise.all([api.balances(), api.lastPrice(market)]);
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
    this.#status = status;
    this.#guard.killed = true;
    clearTimeout(this.#timer);
    const { market, log } = this.#context;
    const open = await this.#api.openOrders(market);
    for (const order of open) {
      await this.#api.cancel(order.id);
    }
    if (status === "killed") {
      this.killReason = reason;
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
