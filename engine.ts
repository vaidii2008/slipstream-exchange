// The matching engine: pure, synchronous, no I/O. Prices and quantities are bigint minor
// units; the engine never needs to know the scale, only to compare and subtract them.

export type Side = "buy" | "sell";

export type RestingOrder = {
  id: string;
  userId: string;
  side: Side;
  price: bigint;
  // What is still unfilled. The original quantity lives with the caller.
  remaining: bigint;
};

// All resting orders at one price, oldest first. Arrival order is the time priority, so the
// engine needs no clock.
type PriceLevel = {
  price: bigint;
  orders: RestingOrder[];
};

export type BookSnapshot = {
  bids: { price: bigint; orders: RestingOrder[] }[];
  asks: { price: bigint; orders: RestingOrder[] }[];
};

export class OrderBook {
  // Each side is sorted worst price first, so the best level is the last element and
  // removing it when it empties is a pop, not a shift. Bids ascend, asks descend.
  readonly #bids: PriceLevel[] = [];
  readonly #asks: PriceLevel[] = [];
  readonly #byId = new Map<string, RestingOrder>();

  // Adds an order at the back of its price level. The caller guarantees it does not cross
  // the opposite side.
  rest(order: RestingOrder): void {
    if (order.price <= 0n || order.remaining <= 0n) {
      throw new RangeError(`order ${order.id} needs a positive price and quantity`);
    }
    if (this.#byId.has(order.id)) {
      throw new Error(`order ${order.id} is already on the book`);
    }

    const levels = this.#levels(order.side);
    const index = this.#search(order.side, order.price);
    const existing = levels[index];
    const resting = { ...order };
    if (existing !== undefined && existing.price === order.price) {
      existing.orders.push(resting);
    } else {
      levels.splice(index, 0, { price: order.price, orders: [resting] });
    }
    this.#byId.set(order.id, resting);
  }

  // Copies, best price first on each side, oldest first within a level.
  snapshot(): BookSnapshot {
    const copy = (levels: PriceLevel[]) =>
      [...levels].reverse().map((level) => ({
        price: level.price,
        orders: level.orders.map((order) => ({ ...order })),
      }));
    return { bids: copy(this.#bids), asks: copy(this.#asks) };
  }

  #levels(side: Side): PriceLevel[] {
    return side === "buy" ? this.#bids : this.#asks;
  }

  // Binary search for where `price` sits on one side: the index of its level if it exists,
  // otherwise the index a new level must be inserted at to keep the side sorted.
  #search(side: Side, price: bigint): number {
    const levels = this.#levels(side);
    // Worse means lower for bids and higher for asks: the direction the array is sorted in.
    const isWorse = (a: bigint, b: bigint) => (side === "buy" ? a < b : a > b);
    let low = 0;
    let high = levels.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      const level = levels[middle];
      if (level !== undefined && isWorse(level.price, price)) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    return low;
  }
}
