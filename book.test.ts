import { describe, expect, it } from "vitest";
import { OrderBook, type RestingOrder, type Side } from "./book.ts";

function order(id: string, side: Side, price: bigint, remaining: bigint): RestingOrder {
  return { id, userId: `user-${id}`, side, price, remaining };
}

// Prices and order ids per level, best first: enough to see both orderings at a glance.
function shape(levels: { price: bigint; orders: RestingOrder[] }[]) {
  return levels.map((level) => [level.price, level.orders.map((o) => o.id)]);
}

describe("OrderBook.rest", () => {
  it("sorts bids highest price first", () => {
    const book = new OrderBook();

    book.rest(order("a", "buy", 100n, 1n));
    book.rest(order("b", "buy", 102n, 1n));
    book.rest(order("c", "buy", 101n, 1n));
    book.rest(order("d", "buy", 99n, 1n));

    expect(shape(book.snapshot().bids)).toEqual([
      [102n, ["b"]],
      [101n, ["c"]],
      [100n, ["a"]],
      [99n, ["d"]],
    ]);
  });

  it("sorts asks lowest price first", () => {
    const book = new OrderBook();

    book.rest(order("a", "sell", 105n, 1n));
    book.rest(order("b", "sell", 103n, 1n));
    book.rest(order("c", "sell", 104n, 1n));
    book.rest(order("d", "sell", 106n, 1n));

    expect(shape(book.snapshot().asks)).toEqual([
      [103n, ["b"]],
      [104n, ["c"]],
      [105n, ["a"]],
      [106n, ["d"]],
    ]);
  });

  it("queues orders at the same price in arrival order", () => {
    const book = new OrderBook();

    book.rest(order("first", "buy", 100n, 5n));
    book.rest(order("other", "buy", 101n, 1n));
    book.rest(order("second", "buy", 100n, 3n));
    book.rest(order("third", "buy", 100n, 1n));

    expect(shape(book.snapshot().bids)).toEqual([
      [101n, ["other"]],
      [100n, ["first", "second", "third"]],
    ]);
  });

  it("keeps the two sides apart", () => {
    const book = new OrderBook();

    book.rest(order("bid", "buy", 100n, 1n));
    book.rest(order("ask", "sell", 101n, 1n));

    const snapshot = book.snapshot();
    expect(shape(snapshot.bids)).toEqual([[100n, ["bid"]]]);
    expect(shape(snapshot.asks)).toEqual([[101n, ["ask"]]]);
  });

  it("rejects a duplicate order id", () => {
    const book = new OrderBook();
    book.rest(order("a", "buy", 100n, 1n));

    expect(() => book.rest(order("a", "sell", 200n, 1n))).toThrow(/already on the book/);
  });

  it("rejects a zero price or quantity", () => {
    const book = new OrderBook();

    expect(() => book.rest(order("a", "buy", 0n, 1n))).toThrow(RangeError);
    expect(() => book.rest(order("b", "buy", 100n, 0n))).toThrow(RangeError);
  });

  it("hands out copies, so a snapshot cannot change the book", () => {
    const book = new OrderBook();
    book.rest(order("a", "buy", 100n, 5n));

    const first = book.snapshot();
    const resting = first.bids[0]?.orders[0];
    if (resting !== undefined) {
      resting.remaining = 999n;
    }

    expect(book.snapshot().bids[0]?.orders[0]?.remaining).toBe(5n);
  });
});

describe("OrderBook.remove", () => {
  it("takes an order from the middle of its queue and keeps the rest in order", () => {
    const book = new OrderBook();
    book.rest(order("a", "sell", 100n, 1n));
    book.rest(order("b", "sell", 100n, 2n));
    book.rest(order("c", "sell", 100n, 3n));

    const removed = book.remove("b");

    expect(removed).toEqual(order("b", "sell", 100n, 2n));
    expect(shape(book.snapshot().asks)).toEqual([[100n, ["a", "c"]]]);
    expect(book.has("b")).toBe(false);
  });

  it("drops a price level once its last order is removed", () => {
    const book = new OrderBook();
    book.rest(order("a", "buy", 100n, 1n));
    book.rest(order("b", "buy", 101n, 1n));
    book.rest(order("c", "buy", 102n, 1n));

    book.remove("b");

    expect(shape(book.snapshot().bids)).toEqual([
      [102n, ["c"]],
      [100n, ["a"]],
    ]);
  });

  it("returns what is left after partial fills", () => {
    const book = new OrderBook();
    book.rest(order("a", "sell", 100n, 10n));
    book.fillBest("sell", 4n);

    expect(book.remove("a")?.remaining).toBe(6n);
  });

  it("returns undefined for an order that is not on the book", () => {
    const book = new OrderBook();
    book.rest(order("a", "sell", 100n, 1n));
    book.fillBest("sell", 1n);

    expect(book.remove("a")).toBeUndefined();
    expect(book.remove("never")).toBeUndefined();
  });

  it("lets a removed id rest again", () => {
    const book = new OrderBook();
    book.rest(order("a", "buy", 100n, 1n));
    book.remove("a");

    book.rest(order("a", "buy", 99n, 1n));

    expect(shape(book.snapshot().bids)).toEqual([[99n, ["a"]]]);
  });
});
