// Risk controls that sit between a trading client and the API: pre-trade limits, the loss
// limit and the cancel-everything half of the kill switch. They live outside whatever makes
// the trading decisions (a bot strategy, a language model), so nothing that decides what to
// trade can also decide to trade past them.

import type { ApiClient, MarketInfo, OrderRequest, PlaceResult, Side } from "./client.ts";

// What a trading client may call. A bot's strategy and the MCP server's tools get a RiskGuard
// in this shape, never the bare client.
export type TradingApi = Pick<
  ApiClient,
  "balances" | "openOrders" | "lastPrice" | "markPrice" | "place" | "cancel"
>;

// Hard limits, enforced outside the decision-maker so a bug in it cannot trade past them. The
// bot strategies have soft limits of their own (the maker's inventory cap, the noise trader's
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
};

export type RiskRefusal = "max_order_quantity" | "max_open_orders" | "max_position" | "killed";

// Pre-trade checks. Every order a client places goes through place(), which reads the
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

// The loss half of the kill switch. Before the market's first trade there is no price to
// value base at, so the baseline is the first equity that can be measured.
export class LossLimit {
  readonly #maxLoss: bigint;
  #startEquity: bigint | undefined;

  constructor(maxLoss: bigint, startEquity: bigint | undefined) {
    this.#maxLoss = maxLoss;
    this.#startEquity = startEquity;
  }

  // Why the limit is breached, or undefined while it is not.
  async breach(api: TradingApi, market: MarketInfo): Promise<string | undefined> {
    const now = await equity(api, market);
    if (now === undefined) {
      return undefined;
    }
    this.#startEquity ??= now;
    const loss = this.#startEquity - now;
    if (loss > this.#maxLoss) {
      return `lost ${loss} quote minor units, limit ${this.#maxLoss}`;
    }
    return undefined;
  }
}

// The other half: whatever is still resting in the market, cancelled, so a halted client
// leaves nothing in the book holding its funds. Returns how many were open.
export async function cancelAll(api: TradingApi, market: MarketInfo): Promise<number> {
  const open = await api.openOrders(market);
  for (const order of open) {
    await api.cancel(order.id);
  }
  return open.length;
}
