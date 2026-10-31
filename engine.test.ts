import { describe, expect, it } from "vitest";
import { Engine, type LimitOrder, OrderBook, type RestingOrder, type Side } from "./engine.ts";

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

function limit(id: string, side: Side, price: bigint, quantity: bigint, userId = `user-${id}`) {
  return { id, userId, side, price, quantity } satisfies LimitOrder;
}

// The trades in an event list as [maker, taker, price, quantity].
function trades(events: ReturnType<Engine["submit"]>) {
  return events.flatMap((event) =>
    event.type === "trade"
      ? [[event.makerOrderId, event.takerOrderId, event.price, event.quantity]]
      : [],
  );
}

// Each level as [price, [[order id, remaining], ...]], best first.
function remaining(levels: { price: bigint; orders: RestingOrder[] }[]) {
  return levels.map((level) => [level.price, level.orders.map((o) => [o.id, o.remaining])]);
}

describe("Engine.submit with a limit order", () => {
  it("rests an order that crosses nothing", () => {
    const engine = new Engine();
    engine.submit(limit("ask", "sell", 101n, 5n));

    const events = engine.submit(limit("bid", "buy", 100n, 3n));

    expect(events).toEqual([
      {
        type: "rested",
        orderId: "bid",
        userId: "user-bid",
        side: "buy",
        price: 100n,
        quantity: 3n,
      },
    ]);
    expect(remaining(engine.snapshot().bids)).toEqual([[100n, [["bid", 3n]]]]);
  });

  it("fills an exact match completely and leaves both sides empty", () => {
    const engine = new Engine();
    engine.submit(limit("ask", "sell", 100n, 5n));

    const events = engine.submit(limit("bid", "buy", 100n, 5n));

    expect(events).toEqual([
      {
        type: "trade",
        makerOrderId: "ask",
        makerUserId: "user-ask",
        takerOrderId: "bid",
        takerUserId: "user-bid",
        takerSide: "buy",
        price: 100n,
        quantity: 5n,
      },
    ]);
    expect(engine.snapshot()).toEqual({ bids: [], asks: [] });
  });

  it("trades at the maker's price when the taker would pay more", () => {
    const engine = new Engine();
    engine.submit(limit("ask", "sell", 100n, 1n));

    const events = engine.submit(limit("bid", "buy", 105n, 1n));

    expect(trades(events)).toEqual([["ask", "bid", 100n, 1n]]);
  });

  it("takes the best price first, whatever order the makers arrived in", () => {
    const engine = new Engine();
    engine.submit(limit("dear", "sell", 102n, 1n));
    engine.submit(limit("cheap", "sell", 100n, 1n));
    engine.submit(limit("middle", "sell", 101n, 1n));

    const events = engine.submit(limit("bid", "buy", 102n, 3n));

    expect(trades(events)).toEqual([
      ["cheap", "bid", 100n, 1n],
      ["middle", "bid", 101n, 1n],
      ["dear", "bid", 102n, 1n],
    ]);
  });

  it("takes the oldest order first within a price", () => {
    const engine = new Engine();
    engine.submit(limit("first", "sell", 100n, 2n));
    engine.submit(limit("second", "sell", 100n, 2n));

    const events = engine.submit(limit("bid", "buy", 100n, 3n));

    expect(trades(events)).toEqual([
      ["first", "bid", 100n, 2n],
      ["second", "bid", 100n, 1n],
    ]);
  });

  it("leaves a partly filled maker at the front of its queue", () => {
    const engine = new Engine();
    engine.submit(limit("first", "sell", 100n, 5n));
    engine.submit(limit("second", "sell", 100n, 5n));

    engine.submit(limit("small", "buy", 100n, 2n));
    const events = engine.submit(limit("next", "buy", 100n, 1n));

    expect(trades(events)).toEqual([["first", "next", 100n, 1n]]);
    expect(remaining(engine.snapshot().asks)).toEqual([
      [
        100n,
        [
          ["first", 2n],
          ["second", 5n],
        ],
      ],
    ]);
  });

  it("stops at its limit and rests the remainder at its own price", () => {
    const engine = new Engine();
    engine.submit(limit("a", "sell", 100n, 2n));
    engine.submit(limit("b", "sell", 101n, 2n));
    engine.submit(limit("c", "sell", 103n, 2n));

    const events = engine.submit(limit("bid", "buy", 102n, 10n));

    expect(trades(events)).toEqual([
      ["a", "bid", 100n, 2n],
      ["b", "bid", 101n, 2n],
    ]);
    expect(events.at(-1)).toMatchObject({ type: "rested", orderId: "bid", quantity: 6n });
    expect(remaining(engine.snapshot().bids)).toEqual([[102n, [["bid", 6n]]]]);
    expect(remaining(engine.snapshot().asks)).toEqual([[103n, [["c", 2n]]]]);
  });

  it("matches a sell against the highest bids first", () => {
    const engine = new Engine();
    engine.submit(limit("low", "buy", 98n, 1n));
    engine.submit(limit("high", "buy", 100n, 1n));
    engine.submit(limit("middle", "buy", 99n, 1n));

    const events = engine.submit(limit("ask", "sell", 99n, 5n));

    expect(trades(events)).toEqual([
      ["high", "ask", 100n, 1n],
      ["middle", "ask", 99n, 1n],
    ]);
    expect(events.at(-1)).toMatchObject({ type: "rested", orderId: "ask", quantity: 3n });
    expect(remaining(engine.snapshot().bids)).toEqual([[98n, [["low", 1n]]]]);
  });

  it("rejects a reused order id before touching the book", () => {
    const engine = new Engine();
    engine.submit(limit("bid", "buy", 99n, 1n));
    engine.submit(limit("ask", "sell", 100n, 1n));
    const before = engine.snapshot();

    expect(() => engine.submit(limit("bid", "buy", 100n, 2n))).toThrow(/already on the book/);
    expect(engine.snapshot()).toEqual(before);
  });

  it("rejects a zero price or quantity", () => {
    const engine = new Engine();

    expect(() => engine.submit(limit("a", "buy", 0n, 1n))).toThrow(RangeError);
    expect(() => engine.submit(limit("b", "buy", 100n, 0n))).toThrow(RangeError);
  });
});
