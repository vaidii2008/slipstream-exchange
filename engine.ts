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

  has(id: string): boolean {
    return this.#byId.has(id);
  }

  // The order with priority on one side: oldest at the best price.
  best(side: Side): Readonly<RestingOrder> | undefined {
    return this.#levels(side).at(-1)?.orders[0];
  }

  // Takes `quantity` from the order with priority on one side, removing it once it is empty
  // and its level once that is empty.
  fillBest(side: Side, quantity: bigint): void {
    const levels = this.#levels(side);
    const level = levels.at(-1);
    const head = level?.orders[0];
    if (level === undefined || head === undefined) {
      throw new Error(`no ${side} order to fill`);
    }
    if (quantity <= 0n || quantity > head.remaining) {
      throw new RangeError(`cannot fill ${quantity} of order ${head.id}, ${head.remaining} left`);
    }

    head.remaining -= quantity;
    if (head.remaining === 0n) {
      level.orders.shift();
      this.#byId.delete(head.id);
      if (level.orders.length === 0) {
        levels.pop();
      }
    }
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
