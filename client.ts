// A typed client of the public HTTP API, in minor units. The bots and the MCP server both
// trade through it, so neither has a way into the exchange that a person in the terminal
// does not.

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
  // refused it and nothing was sent. message is the API's explanation, when it sent one.
  | { ok: false; status: number; error: string; message?: string };

// One price level of the book: the total resting quantity at that price.
export type BookLevel = { price: bigint; quantity: bigint };
export type Book = { bids: BookLevel[]; asks: BookLevel[] };

export type Trade = { price: bigint; quantity: bigint; takerSide: Side; createdAt: string };

export type OpenOrder = {
  id: string;
  side: Side;
  price: bigint | null;
  quantity: bigint;
  filled: bigint;
};

// The API prints every amount at its asset's full scale, so the number of decimals in any
// one amount is that asset's scale.
function scaleOf(amount: string): number {
  return amount.split(".")[1]?.length ?? 0;
}

export function units(amount: string, scale: number): bigint {
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
const errorReply = z.object({ error: z.string(), message: z.string().optional() });
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
const tradesReply = z.object({
  trades: z.array(
    z.object({
      price: z.string(),
      quantity: z.string(),
      takerSide: z.enum(["buy", "sell"]),
      createdAt: z.string(),
    }),
  ),
});
const levelReply = z.object({ price: z.string(), quantity: z.string() });
const bookReply = z.object({ bids: z.array(levelReply), asks: z.array(levelReply) });

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
    if (!parsed.success) {
      return { ok: false, status: reply.status, error: "unknown" };
    }
    const { error, message } = parsed.data;
    return {
      ok: false,
      status: reply.status,
      error,
      ...(message === undefined ? {} : { message }),
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

  // The prices of the market's latest trades, newest first.
  async recentPrices(market: MarketInfo, limit: number): Promise<bigint[]> {
    return (await this.recentTrades(market, limit)).map((trade) => trade.price);
  }

  // The market's latest trades, newest first.
  async recentTrades(market: MarketInfo, limit: number): Promise<Trade[]> {
    const path = `/markets/${encodeURIComponent(market.symbol)}/trades?limit=${limit}`;
    const reply = await this.#send("GET", path, undefined, false);
    if (reply.status !== 200) {
      throw new ApiError("GET", path, reply.status, reply.body);
    }
    return tradesReply.parse(reply.body).trades.map((trade) => ({
      price: units(trade.price, market.quoteScale),
      quantity: units(trade.quantity, market.baseScale),
      takerSide: trade.takerSide,
      createdAt: trade.createdAt,
    }));
  }

  // The best `depth` levels each side, best first.
  async book(market: MarketInfo, depth: number): Promise<Book> {
    const path = `/markets/${encodeURIComponent(market.symbol)}/book?depth=${depth}`;
    const reply = await this.#send("GET", path, undefined, false);
    if (reply.status !== 200) {
      throw new ApiError("GET", path, reply.status, reply.body);
    }
    const body = bookReply.parse(reply.body);
    const level = (entry: z.infer<typeof levelReply>): BookLevel => ({
      price: units(entry.price, market.quoteScale),
      quantity: units(entry.quantity, market.baseScale),
    });
    return { bids: body.bids.map(level), asks: body.asks.map(level) };
  }

  // The price of the market's latest trade, or undefined before its first.
  async lastPrice(market: MarketInfo): Promise<bigint | undefined> {
    const [latest] = await this.recentPrices(market, 1);
    return latest;
  }

  // The price equity is valued at. See markFrom.
  async markPrice(market: MarketInfo): Promise<bigint | undefined> {
    return markFrom(await this.recentPrices(market, MARK_WINDOW));
  }
}

// Trades the mark looks back over.
export const MARK_WINDOW = 20;

// The median of the last MARK_WINDOW trade prices, or the last trade's while there are fewer.
// The last trade alone lets one off-price fill (a market order sweeping a thin book, a test
// run writing to the wrong database) swing a maker's equity by thousands and trip its loss
// limit; one outlier in twenty cannot move a median. With an even window it is the mean of
// the two middle prices, rounded down. `prices` is newest first; undefined when empty.
export function markFrom(prices: bigint[]): bigint | undefined {
  if (prices.length < MARK_WINDOW) {
    return prices[0];
  }
  const sorted = prices.slice(0, MARK_WINDOW).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const upper = sorted[MARK_WINDOW / 2];
  const lower = sorted[MARK_WINDOW / 2 - 1];
  if (upper === undefined || lower === undefined) {
    throw new Error("mark window has no middle");
  }
  return (lower + upper) / 2n;
}
