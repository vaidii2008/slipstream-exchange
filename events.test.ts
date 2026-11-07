import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { decode, readLog } from "./events.ts";
import { Exchange, MarketHaltedError } from "./exchange.ts";
import { balancesOf, deposit } from "./ledger.ts";
import { parseAmount } from "./money.ts";
import { engineEvents, orders, users } from "./schema.ts";
import { useTestServer } from "./testing.ts";

const { db, uniqueEmail, testMarket } = useTestServer();

const units = (value: string): bigint => {
  const parsed = parseAmount(value, 8);
  if (!parsed.ok) {
    throw new Error(`bad test amount ${value}: ${parsed.reason}`);
  }
  return parsed.units;
};

async function funded(holdings: Record<string, string>): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({ email: uniqueEmail("events-test"), passwordHash: "not-a-real-hash" })
    .returning({ id: users.id });
  if (user === undefined) {
    throw new Error("user insert returned no row");
  }
  for (const [asset, amount] of Object.entries(holdings)) {
    await deposit(db, user.id, asset, units(amount));
  }
  return user.id;
}

const limit = (userId: string, side: "buy" | "sell", price: string, quantity: string) => ({
  type: "limit" as const,
  userId,
  side,
  price: units(price),
  quantity: units(quantity),
});

describe("the event log", () => {
  it("holds every command in order, each numbered by its first event", async () => {
    const market = await testMarket("BTC-USD");
    const exchange = new Exchange(db);
    const seller = await funded({ BTC: "1" });
    const buyer = await funded({ USD: "100000" });

    // 1: the ask rests. 2: a trade, 3: the rest of the bid rests. 4: the bid is cancelled.
    // 5: a cancel of the filled ask, rejected. 6: a bid rests. 7: a market sell trades with
    // it, at the protection price it was given on arrival.
    const ask = await exchange.placeOrder(market, limit(seller, "sell", "60000", "0.1"));
    const bid = await exchange.placeOrder(market, {
      ...limit(buyer, "buy", "60000", "0.3"),
      clientOrderId: "not-logged",
    });
    await exchange.cancelOrder(market, bid.id);
    await exchange.cancelOrder(market, ask.id);
    await exchange.placeOrder(market, limit(buyer, "buy", "59000", "0.1"));
    const sell = await exchange.placeOrder(market, {
      type: "market",
      userId: seller,
      side: "sell",
      quantity: units("0.05"),
    });

    const log = await readLog(db, market.symbol);
    expect(log.every((entry) => entry.loggedAt instanceof Date)).toBe(true);
    expect(log.map(({ sequence, command }) => ({ sequence, command }))).toEqual([
      {
        sequence: 1,
        command: {
          type: "submit",
          order: { ...limit(seller, "sell", "60000", "0.1"), id: ask.id },
        },
      },
      {
        sequence: 2,
        // The client's own id is not the engine's business, so it is not logged.
        command: { type: "submit", order: { ...limit(buyer, "buy", "60000", "0.3"), id: bid.id } },
      },
      { sequence: 4, command: { type: "cancel", orderId: bid.id } },
      { sequence: 5, command: { type: "cancel", orderId: ask.id } },
      {
        sequence: 6,
        command: { type: "submit", order: expect.objectContaining({ side: "buy" }) as unknown },
      },
      {
        sequence: 7,
        command: {
          type: "submit",
          order: {
            type: "market",
            id: sell.id,
            userId: seller,
            side: "sell",
            quantity: units("0.05"),
            // 5% below the best bid of 59,000.
            protectionPrice: units("56050"),
          },
        },
      },
    ]);
  });

  it("halts the market when the log refuses a command, before the engine sees it", async () => {
    const market = await testMarket("BTC-USD");
    const exchange = new Exchange(db);
    const halts: string[] = [];
    exchange.onHalt((symbol) => halts.push(symbol));
    const buyer = await funded({ USD: "10000" });
    // Once this exchange has opened the empty market, another writer takes sequence 1.
    await exchange.open([market]);
    await db.insert(engineEvents).values({
      market: market.symbol,
      sequence: 1,
      commandType: "cancel",
      payload: { orderId: "someone-elses" },
    });

    await expect(
      exchange.placeOrder(market, limit(buyer, "buy", "60000", "0.1")),
    ).rejects.toBeInstanceOf(MarketHaltedError);

    expect(halts).toEqual([market.symbol]);
    expect(exchange.depth(market.symbol, 10)).toEqual({ sequence: 0, bids: [], asks: [] });
    // Reserved and recorded but never logged: still pending, for recovery to cancel.
    const [row] = await db
      .select({ status: orders.status })
      .from(orders)
      .where(eq(orders.userId, buyer));
    expect(row).toEqual({ status: "pending" });
    expect((await balancesOf(db, buyer)).find((b) => b.asset === "USD")).toMatchObject({
      reserved: units("6000"),
    });
  });
});

describe("rebuilding books from the log", () => {
  it("gives a new exchange the same book, FIFO order and next sequence", async () => {
    const market = await testMarket("BTC-USD");
    const before = new Exchange(db);
    const first = await funded({ BTC: "1" });
    const second = await funded({ BTC: "1" });
    const buyer = await funded({ USD: "100000" });
    // Two asks at 60,000, ahead's first in the queue, and one at 60,100. A bid takes 0.05 of
    // ahead's; a bid rests and is cancelled; a market buy of 0.3 takes the 0.15 left of ahead's
    // and 0.15 of behind's, leaving 0.05 of behind's; a bid rests.
    const ahead = await before.placeOrder(market, limit(first, "sell", "60000", "0.2"));
    const behind = await before.placeOrder(market, limit(second, "sell", "60000", "0.2"));
    await before.placeOrder(market, limit(second, "sell", "60100", "0.3"));
    await before.placeOrder(market, limit(buyer, "buy", "60000", "0.05"));
    const cancelled = await before.placeOrder(market, limit(buyer, "buy", "59000", "0.1"));
    await before.cancelOrder(market, cancelled.id);
    await before.placeOrder(market, {
      type: "market",
      userId: buyer,
      side: "buy",
      quantity: units("0.3"),
    });
    await before.placeOrder(market, limit(buyer, "buy", "59500", "0.1"));
    const book = before.depth(market.symbol, 50);

    // A process that starts with nothing but the database.
    const after = new Exchange(db);
    await expect(after.open([market])).resolves.toEqual([
      { market: market.symbol, sequence: book.sequence, halted: false, settled: 0, cancelled: 0 },
    ]);

    expect(after.depth(market.symbol, 50)).toEqual(book);
    // The rebuilt queue still has behind's 0.05 first at 60,000, so a buy of 0.05 fills it
    // there, at the sequence after the last logged one.
    const taker = await after.placeOrder(market, limit(buyer, "buy", "60100", "0.05"));
    expect(taker).toMatchObject({ status: "filled", fills: [{ price: units("60000") }] });
    const [aheadRow, behindRow] = await Promise.all(
      [ahead.id, behind.id].map(async (id) => {
        const [row] = await db
          .select({ status: orders.status, sequence: orders.engineSequence })
          .from(orders)
          .where(eq(orders.id, id));
        return row;
      }),
    );
    expect(aheadRow?.status).toBe("filled");
    expect(behindRow).toEqual({ status: "filled", sequence: book.sequence + 1 });
  });

  it("halts a market whose log has a gap and opens the others", async () => {
    const broken = await testMarket("BTC-USD");
    const fine = await testMarket("ETH-USD");
    for (const sequence of [1, 3]) {
      await db.insert(engineEvents).values({
        market: broken.symbol,
        sequence,
        commandType: "cancel",
        payload: { orderId: `missing-${sequence}` },
      });
    }
    const exchange = new Exchange(db);
    const halts: unknown[] = [];
    exchange.onHalt((_symbol, error) => halts.push(error));

    await expect(exchange.open([broken, fine])).resolves.toEqual([
      { market: broken.symbol, sequence: 1, halted: true, settled: 0, cancelled: 0 },
      { market: fine.symbol, sequence: 0, halted: false, settled: 0, cancelled: 0 },
    ]);
    expect(halts).toEqual([
      expect.objectContaining({ message: "event log has command 3 where 2 was next" }),
    ]);
    const seller = await funded({ BTC: "1", ETH: "1" });
    await expect(
      exchange.placeOrder(broken, limit(seller, "sell", "60000", "0.1")),
    ).rejects.toBeInstanceOf(MarketHaltedError);
    await expect(
      exchange.placeOrder(fine, limit(seller, "sell", "3000", "0.1")),
    ).resolves.toMatchObject({ status: "open" });
  });
});

describe("decode", () => {
  const order = { type: "limit", id: "o", userId: "u", side: "buy", quantity: "100" };

  it("reads amounts back as exact bigints", () => {
    expect(decode("submit", { order: { ...order, price: "6000000000000" } })).toEqual({
      type: "submit",
      order: { ...order, price: 6_000_000_000_000n, quantity: 100n },
    });
  });

  it.each(["1.5", "-1", "1e3", ""])("refuses %j as an amount rather than round it", (price) => {
    expect(() => decode("submit", { order: { ...order, price } })).toThrow();
  });

  it("refuses a payload with a field it does not know", () => {
    expect(() => decode("cancel", { orderId: "o", extra: true })).toThrow();
  });
});
