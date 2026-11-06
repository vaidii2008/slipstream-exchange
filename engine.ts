// The matching engine: pure, synchronous, no I/O. Prices and quantities are bigint minor
// units; the engine never needs to know the scale, only to compare and subtract them.

import { type BookSnapshot, type DepthLevel, OrderBook, type Side } from "./book.ts";

export type LimitOrder = {
  type: "limit";
  id: string;
  userId: string;
  side: Side;
  price: bigint;
  quantity: bigint;
};

// Takes whatever the book offers, up to `quantity`, and never rests. With a protection price
// it trades no worse than that price (a buy pays at most it, a sell receives at least it) and
// cancels the rest; without one it takes any price.
export type MarketOrder = {
  type: "market";
  id: string;
  userId: string;
  side: Side;
  quantity: bigint;
  protectionPrice?: bigint;
};

export type NewOrder = LimitOrder | MarketOrder;

// What happened, without the stamp every event gets on the way out.
export type EventBody =
  | {
      type: "trade";
      makerOrderId: string;
      makerUserId: string;
      takerOrderId: string;
      takerUserId: string;
      // The taker's side; the maker was on the other one.
      takerSide: Side;
      // Always the maker's price: the resting order set it, the taker accepted it.
      price: bigint;
      quantity: bigint;
    }
  | {
      type: "rested";
      orderId: string;
      userId: string;
      side: Side;
      price: bigint;
      quantity: bigint;
    }
  | {
      // The order's unfilled quantity left the engine without trading: a market order whose
      // book ran out, a resting order its owner cancelled, or an incoming order that reached
      // its owner's own resting order.
      type: "cancelled";
      orderId: string;
      userId: string;
      side: Side;
      // Null for a market order, which has no price.
      price: bigint | null;
      quantity: bigint;
      reason: "no_liquidity" | "requested" | "self_trade";
    }
  | {
      // Nothing to cancel: the order already filled, was already cancelled, or never rested.
      // Expected in normal running, since a cancel can race the fill that empties the order.
      type: "cancel_rejected";
      orderId: string;
      reason: "not_found";
    };

// Sequence numbers start at 1 and rise by exactly 1 per event in a market, so a consumer
// that sees 41 then 43 knows it missed one and must resync.
export type EngineEvent = EventBody & { market: string; sequence: number };

const opposite = (side: Side): Side => (side === "buy" ? "sell" : "buy");

// One engine per market. Every call runs to completion before the next, so the book has
// exactly one writer and needs no locks.
export class Engine {
  readonly #book = new OrderBook();
  readonly #market: string;
  #sequence = 0;

  constructor(market: string) {
    this.#market = market;
  }

  // Number of the last event emitted, 0 before the first.
  get sequence(): number {
    return this.#sequence;
  }

  // Matches the order against the opposite side, best price first and oldest first within a
  // price. The incoming order is the taker; resting ones are makers. What a limit order has
  // left rests at its price; what a market order has left is cancelled.
  submit(order: NewOrder): EngineEvent[] {
    return this.#stamp(this.#match(order));
  }

  #match(order: NewOrder): EventBody[] {
    // The worst price the order may trade at, if it has one.
    const limit = order.type === "limit" ? order.price : order.protectionPrice;
    if (order.quantity <= 0n || (limit !== undefined && limit <= 0n)) {
      throw new RangeError(`order ${order.id} needs a positive price and quantity`);
    }
    // Checked before matching: failing at rest time would leave the trades half applied.
    if (this.#book.has(order.id)) {
      throw new Error(`order ${order.id} is already on the book`);
    }

    const events: EventBody[] = [];
    const makerSide = opposite(order.side);
    // A buy crosses any ask at or below its limit; a sell crosses any bid at or above it. A
    // market order without a protection price crosses everything.
    const crosses = (price: bigint) =>
      limit === undefined || (order.side === "buy" ? price <= limit : price >= limit);

    let remaining = order.quantity;
    let selfTrade = false;
    for (let maker = this.#book.best(makerSide); maker !== undefined && remaining > 0n;) {
      if (!crosses(maker.price)) {
        break;
      }
      // Self-trade prevention, cancel-newest: a user trading with themselves would print a
      // fake trade, so the incoming order stops here. Fills before this point stand, and the
      // resting order keeps its place.
      if (maker.userId === order.userId) {
        selfTrade = true;
        break;
      }
      const quantity = remaining < maker.remaining ? remaining : maker.remaining;
      events.push({
        type: "trade",
        makerOrderId: maker.id,
        makerUserId: maker.userId,
        takerOrderId: order.id,
        takerUserId: order.userId,
        takerSide: order.side,
        price: maker.price,
        quantity,
      });
      this.#book.fillBest(makerSide, quantity);
      remaining -= quantity;
      maker = this.#book.best(makerSide);
    }

    if (remaining === 0n) {
      return events;
    }
    // A limit order's remainder cannot rest after a self-trade stop: it would cross its
    // owner's order and leave the book crossed.
    if (selfTrade || order.type === "market") {
      events.push({
        type: "cancelled",
        orderId: order.id,
        userId: order.userId,
        side: order.side,
        price: order.type === "limit" ? order.price : null,
        quantity: remaining,
        reason: selfTrade ? "self_trade" : "no_liquidity",
      });
      return events;
    }

    this.#book.rest({
      id: order.id,
      userId: order.userId,
      side: order.side,
      price: order.price,
      remaining,
    });
    events.push({
      type: "rested",
      orderId: order.id,
      userId: order.userId,
      side: order.side,
      price: order.price,
      quantity: remaining,
    });
    return events;
  }

  cancel(orderId: string): EngineEvent[] {
    const order = this.#book.remove(orderId);
    if (order === undefined) {
      return this.#stamp([{ type: "cancel_rejected", orderId, reason: "not_found" }]);
    }
    return this.#stamp([
      {
        type: "cancelled",
        orderId: order.id,
        userId: order.userId,
        side: order.side,
        price: order.price,
        quantity: order.remaining,
        reason: "requested",
      },
    ]);
  }

  snapshot(): BookSnapshot {
    return this.#book.snapshot();
  }

  // The book aggregated by price level, with the sequence number it is current as of.
  depth(limit: number): { sequence: number; bids: DepthLevel[]; asks: DepthLevel[] } {
    return { sequence: this.#sequence, ...this.#book.depth(limit) };
  }

  // The best resting price on one side, undefined when that side is empty.
  bestPrice(side: Side): bigint | undefined {
    return this.#book.best(side)?.price;
  }

  // Numbers events only once a command has run to completion, so a command that throws on
  // bad input uses up no sequence numbers.
  #stamp(bodies: EventBody[]): EngineEvent[] {
    return bodies.map((body) => ({ ...body, market: this.#market, sequence: ++this.#sequence }));
  }
}
