import { describe, expect, it } from "vitest";
import type { RestingOrder, Side } from "./book.ts";
import {
  Engine,
  type EngineEvent,
  type EventBody,
  type LimitOrder,
  type MarketOrder,
} from "./engine.ts";

function limit(id: string, side: Side, price: bigint, quantity: bigint, userId = `user-${id}`) {
  return { type: "limit", id, userId, side, price, quantity } satisfies LimitOrder;
}

function market(id: string, side: Side, quantity: bigint, userId = `user-${id}`) {
  return { type: "market", id, userId, side, quantity } satisfies MarketOrder;
}

// The trades in an event list as [maker, taker, price, quantity].
// Drops the market and sequence stamp, for tests about what happened rather than its number.
function unstamped(events: EngineEvent[]): EventBody[] {
  return events.map(({ market: _market, sequence: _sequence, ...body }) => body);
}

function trades(events: EngineEvent[]) {
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
    const engine = new Engine("TEST");
    engine.submit(limit("ask", "sell", 101n, 5n));

    const events = engine.submit(limit("bid", "buy", 100n, 3n));

    expect(unstamped(events)).toEqual([
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
    const engine = new Engine("TEST");
    engine.submit(limit("ask", "sell", 100n, 5n));

    const events = engine.submit(limit("bid", "buy", 100n, 5n));

    expect(unstamped(events)).toEqual([
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
    const engine = new Engine("TEST");
    engine.submit(limit("ask", "sell", 100n, 1n));

    const events = engine.submit(limit("bid", "buy", 105n, 1n));

    expect(trades(events)).toEqual([["ask", "bid", 100n, 1n]]);
  });

  it("takes the best price first, whatever order the makers arrived in", () => {
    const engine = new Engine("TEST");
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
    const engine = new Engine("TEST");
    engine.submit(limit("first", "sell", 100n, 2n));
    engine.submit(limit("second", "sell", 100n, 2n));

    const events = engine.submit(limit("bid", "buy", 100n, 3n));

    expect(trades(events)).toEqual([
      ["first", "bid", 100n, 2n],
      ["second", "bid", 100n, 1n],
    ]);
  });

  it("leaves a partly filled maker at the front of its queue", () => {
    const engine = new Engine("TEST");
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
    const engine = new Engine("TEST");
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
    const engine = new Engine("TEST");
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
    const engine = new Engine("TEST");
    engine.submit(limit("bid", "buy", 99n, 1n));
    engine.submit(limit("ask", "sell", 100n, 1n));
    const before = engine.snapshot();

    expect(() => engine.submit(limit("bid", "buy", 100n, 2n))).toThrow(/already on the book/);
    expect(engine.snapshot()).toEqual(before);
  });

  it("rejects a zero price or quantity", () => {
    const engine = new Engine("TEST");

    expect(() => engine.submit(limit("a", "buy", 0n, 1n))).toThrow(RangeError);
    expect(() => engine.submit(limit("b", "buy", 100n, 0n))).toThrow(RangeError);
  });
});

describe("Engine.submit with a market order", () => {
  it("sweeps price levels in priority order regardless of price", () => {
    const engine = new Engine("TEST");
    engine.submit(limit("a", "sell", 100n, 2n));
    engine.submit(limit("b", "sell", 150n, 2n));
    engine.submit(limit("c", "sell", 900n, 2n));

    const events = engine.submit(market("buy", "buy", 5n));

    expect(trades(events)).toEqual([
      ["a", "buy", 100n, 2n],
      ["b", "buy", 150n, 2n],
      ["c", "buy", 900n, 1n],
    ]);
    expect(events).toHaveLength(3);
    expect(remaining(engine.snapshot().asks)).toEqual([[900n, [["c", 1n]]]]);
  });

  it("cancels what the book could not fill instead of resting it", () => {
    const engine = new Engine("TEST");
    engine.submit(limit("bid", "buy", 100n, 3n));

    const events = engine.submit(market("sell", "sell", 10n));

    expect(trades(events)).toEqual([["bid", "sell", 100n, 3n]]);
    expect(unstamped(events).at(-1)).toEqual({
      type: "cancelled",
      orderId: "sell",
      userId: "user-sell",
      side: "sell",
      price: null,
      quantity: 7n,
      reason: "no_liquidity",
    });
    expect(engine.snapshot()).toEqual({ bids: [], asks: [] });
  });

  it("cancels the whole order against an empty side", () => {
    const engine = new Engine("TEST");
    engine.submit(limit("bid", "buy", 100n, 3n));

    const events = engine.submit(market("buy", "buy", 4n));

    expect(unstamped(events)).toEqual([
      {
        type: "cancelled",
        orderId: "buy",
        userId: "user-buy",
        side: "buy",
        price: null,
        quantity: 4n,
        reason: "no_liquidity",
      },
    ]);
    expect(remaining(engine.snapshot().bids)).toEqual([[100n, [["bid", 3n]]]]);
  });

  it("rejects a zero quantity", () => {
    const engine = new Engine("TEST");

    expect(() => engine.submit(market("m", "buy", 0n))).toThrow(RangeError);
  });
});

describe("Engine.cancel", () => {
  it("removes a resting order and reports what it had left", () => {
    const engine = new Engine("TEST");
    engine.submit(limit("ask", "sell", 100n, 5n));
    engine.submit(limit("bid", "buy", 100n, 2n));

    const events = engine.cancel("ask");

    expect(unstamped(events)).toEqual([
      {
        type: "cancelled",
        orderId: "ask",
        userId: "user-ask",
        side: "sell",
        price: 100n,
        quantity: 3n,
        reason: "requested",
      },
    ]);
    expect(engine.snapshot()).toEqual({ bids: [], asks: [] });
  });

  it("stops a cancelled order from trading", () => {
    const engine = new Engine("TEST");
    engine.submit(limit("first", "sell", 100n, 1n));
    engine.submit(limit("second", "sell", 100n, 1n));
    engine.cancel("first");

    const events = engine.submit(limit("bid", "buy", 100n, 1n));

    expect(trades(events)).toEqual([["second", "bid", 100n, 1n]]);
  });

  it("rejects a cancel for an order that already filled", () => {
    const engine = new Engine("TEST");
    engine.submit(limit("ask", "sell", 100n, 1n));
    engine.submit(limit("bid", "buy", 100n, 1n));

    expect(unstamped(engine.cancel("ask"))).toEqual([
      { type: "cancel_rejected", orderId: "ask", reason: "not_found" },
    ]);
  });

  it("rejects a cancel for an id it has never seen and leaves the book alone", () => {
    const engine = new Engine("TEST");
    engine.submit(limit("bid", "buy", 100n, 1n));
    const before = engine.snapshot();

    expect(unstamped(engine.cancel("ghost"))).toEqual([
      { type: "cancel_rejected", orderId: "ghost", reason: "not_found" },
    ]);
    expect(engine.snapshot()).toEqual(before);
  });
});

describe("self-trade prevention", () => {
  it("cancels an incoming limit order that would trade with its owner's resting order", () => {
    const engine = new Engine("TEST");
    engine.submit(limit("mine", "sell", 100n, 5n, "alice"));

    const events = engine.submit(limit("also-mine", "buy", 100n, 3n, "alice"));

    expect(unstamped(events)).toEqual([
      {
        type: "cancelled",
        orderId: "also-mine",
        userId: "alice",
        side: "buy",
        price: 100n,
        quantity: 3n,
        reason: "self_trade",
      },
    ]);
    expect(remaining(engine.snapshot().asks)).toEqual([[100n, [["mine", 5n]]]]);
    expect(engine.snapshot().bids).toEqual([]);
  });

  it("keeps fills made before reaching the owner's order and cancels only the rest", () => {
    const engine = new Engine("TEST");
    engine.submit(limit("bob-ask", "sell", 100n, 2n, "bob"));
    engine.submit(limit("alice-ask", "sell", 101n, 5n, "alice"));
    engine.submit(limit("carol-ask", "sell", 102n, 5n, "carol"));

    const events = engine.submit(limit("alice-bid", "buy", 102n, 6n, "alice"));

    expect(trades(events)).toEqual([["bob-ask", "alice-bid", 100n, 2n]]);
    expect(events.at(-1)).toMatchObject({
      type: "cancelled",
      orderId: "alice-bid",
      quantity: 4n,
      reason: "self_trade",
    });
    // Carol's ask is untouched: matching stopped at Alice's own order, which is ahead of it.
    expect(remaining(engine.snapshot().asks)).toEqual([
      [101n, [["alice-ask", 5n]]],
      [102n, [["carol-ask", 5n]]],
    ]);
  });

  it("applies to market orders too", () => {
    const engine = new Engine("TEST");
    engine.submit(limit("mine", "buy", 100n, 5n, "alice"));

    const events = engine.submit(market("sweep", "sell", 2n, "alice"));

    expect(unstamped(events)).toEqual([
      {
        type: "cancelled",
        orderId: "sweep",
        userId: "alice",
        side: "sell",
        price: null,
        quantity: 2n,
        reason: "self_trade",
      },
    ]);
  });

  it("does not stop a limit order whose own resting order is past its limit", () => {
    const engine = new Engine("TEST");
    engine.submit(limit("bob-ask", "sell", 100n, 1n, "bob"));
    engine.submit(limit("alice-ask", "sell", 105n, 1n, "alice"));

    const events = engine.submit(limit("alice-bid", "buy", 101n, 3n, "alice"));

    expect(trades(events)).toEqual([["bob-ask", "alice-bid", 100n, 1n]]);
    expect(events.at(-1)).toMatchObject({ type: "rested", orderId: "alice-bid", quantity: 2n });
  });
});

describe("event sequence numbers", () => {
  it("stamps every event with its market and a sequence that rises by one", () => {
    const engine = new Engine("BTC-USD");

    const first = engine.submit(limit("a", "sell", 100n, 1n));
    const second = engine.submit(limit("b", "sell", 101n, 1n));
    const sweep = engine.submit(market("m", "buy", 3n));
    const cancel = engine.cancel("a");

    const all = [...first, ...second, ...sweep, ...cancel];
    expect(all.map((event) => [event.type, event.sequence])).toEqual([
      ["rested", 1],
      ["rested", 2],
      ["trade", 3],
      ["trade", 4],
      ["cancelled", 5],
      ["cancel_rejected", 6],
    ]);
    expect(all.every((event) => event.market === "BTC-USD")).toBe(true);
    expect(engine.sequence).toBe(6);
  });

  it("starts at 0 and spends no numbers on a command that throws", () => {
    const engine = new Engine("BTC-USD");
    expect(engine.sequence).toBe(0);

    expect(() => engine.submit(limit("bad", "buy", 100n, 0n))).toThrow(RangeError);
    const events = engine.submit(limit("good", "buy", 100n, 1n));

    expect(events.map((event) => event.sequence)).toEqual([1]);
  });

  it("counts each market on its own", () => {
    const btc = new Engine("BTC-USD");
    const eth = new Engine("ETH-USD");

    btc.submit(limit("a", "buy", 100n, 1n));
    btc.submit(limit("b", "buy", 100n, 1n));
    const events = eth.submit(limit("c", "buy", 100n, 1n));

    expect(events).toEqual([expect.objectContaining({ market: "ETH-USD", sequence: 1 })]);
    expect(btc.sequence).toBe(2);
  });
});
