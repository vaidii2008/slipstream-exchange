// The matching engine: pure, synchronous, no I/O. Prices and quantities are bigint minor
// units; the engine never needs to know the scale, only to compare and subtract them.

import { type BookSnapshot, OrderBook, type Side } from "./book.ts";

export type LimitOrder = {
  id: string;
  userId: string;
  side: Side;
  price: bigint;
  quantity: bigint;
};

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
    };

const opposite = (side: Side): Side => (side === "buy" ? "sell" : "buy");

// One engine per market. Every call runs to completion before the next, so the book has
// exactly one writer and needs no locks.
export class Engine {
  readonly #book = new OrderBook();

  // Matches the order against the opposite side, best price first and oldest first within a
  // price, then rests whatever is left. The incoming order is the taker; resting ones are makers.
  submit(order: LimitOrder): EngineEvent[] {
    if (order.price <= 0n || order.quantity <= 0n) {
      throw new RangeError(`order ${order.id} needs a positive price and quantity`);
    }
    // Checked before matching: failing at rest time would leave the trades half applied.
    if (this.#book.has(order.id)) {
      throw new Error(`order ${order.id} is already on the book`);
    }

    const events: EngineEvent[] = [];
    const makerSide = opposite(order.side);
    // A buy crosses any ask at or below its limit; a sell crosses any bid at or above it.
    const crosses = (price: bigint) =>
      order.side === "buy" ? price <= order.price : price >= order.price;

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

    if (remaining > 0n) {
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
    }
    return events;
  }

  snapshot(): BookSnapshot {
    return this.#book.snapshot();
  }
}
