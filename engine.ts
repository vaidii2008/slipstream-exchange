// The matching engine: pure, synchronous, no I/O. Prices and quantities are bigint minor
// units; the engine never needs to know the scale, only to compare and subtract them.

import { type BookSnapshot, OrderBook, type Side } from "./book.ts";

export type LimitOrder = {
  type: "limit";
  id: string;
  userId: string;
  side: Side;
  price: bigint;
  quantity: bigint;
};

// Takes whatever the book offers at any price, up to `quantity`, and never rests.
export type MarketOrder = {
  type: "market";
  id: string;
  userId: string;
  side: Side;
  quantity: bigint;
};

export type NewOrder = LimitOrder | MarketOrder;

export type EngineEvent =
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
      // book ran out, or a resting order its owner cancelled.
      type: "cancelled";
      orderId: string;
      userId: string;
      side: Side;
      // Null for a market order, which has no price.
      price: bigint | null;
      quantity: bigint;
      reason: "no_liquidity" | "requested";
    }
  | {
      // Nothing to cancel: the order already filled, was already cancelled, or never rested.
      // Expected in normal running, since a cancel can race the fill that empties the order.
      type: "cancel_rejected";
      orderId: string;
      reason: "not_found";
    };

const opposite = (side: Side): Side => (side === "buy" ? "sell" : "buy");

// One engine per market. Every call runs to completion before the next, so the book has
// exactly one writer and needs no locks.
export class Engine {
  readonly #book = new OrderBook();

  // Matches the order against the opposite side, best price first and oldest first within a
  // price. The incoming order is the taker; resting ones are makers. What a limit order has
  // left rests at its price; what a market order has left is cancelled.
  submit(order: NewOrder): EngineEvent[] {
    if (order.quantity <= 0n || (order.type === "limit" && order.price <= 0n)) {
      throw new RangeError(`order ${order.id} needs a positive price and quantity`);
    }
    // Checked before matching: failing at rest time would leave the trades half applied.
    if (this.#book.has(order.id)) {
      throw new Error(`order ${order.id} is already on the book`);
    }

    const events: EngineEvent[] = [];
    const makerSide = opposite(order.side);
    // A buy crosses any ask at or below its limit; a sell crosses any bid at or above it. A
    // market order crosses everything.
    const crosses = (price: bigint) =>
      order.type === "market" ||
      (order.side === "buy" ? price <= order.price : price >= order.price);

    let remaining = order.quantity;
    for (let maker = this.#book.best(makerSide); maker !== undefined && remaining > 0n;) {
      if (!crosses(maker.price)) {
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
    if (order.type === "market") {
      events.push({
        type: "cancelled",
        orderId: order.id,
        userId: order.userId,
        side: order.side,
        price: null,
        quantity: remaining,
        reason: "no_liquidity",
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
      return [{ type: "cancel_rejected", orderId, reason: "not_found" }];
    }
    return [
      {
        type: "cancelled",
        orderId: order.id,
        userId: order.userId,
        side: order.side,
        price: order.price,
        quantity: order.remaining,
        reason: "requested",
      },
    ];
  }

  snapshot(): BookSnapshot {
    return this.#book.snapshot();
  }
}
