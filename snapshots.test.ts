import { asc, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { Engine } from "./engine.ts";
import { readLog, replay } from "./events.ts";
import { Exchange } from "./exchange.ts";
import { deposit } from "./ledger.ts";
import { parseAmount } from "./money.ts";
import { bookSnapshots, users } from "./schema.ts";
import { serializeEngine } from "./snapshots.ts";
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
    .values({ email: uniqueEmail("snapshots-test"), passwordHash: "not-a-real-hash" })
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

async function snapshotsOf(market: string) {
  return db
    .select({ sequence: bookSnapshots.sequence, book: bookSnapshots.book })
    .from(bookSnapshots)
    .where(eq(bookSnapshots.market, market))
    .orderBy(asc(bookSnapshots.sequence));
}

describe("serializeEngine", () => {
  it("writes the sequence and every resting order, best price and oldest first", () => {
    const engine = new Engine("BTC-USD");
    engine.submit({
      type: "limit",
      id: "a1",
      userId: "u1",
      side: "sell",
      price: 101n,
      quantity: 5n,
    });
    engine.submit({
      type: "limit",
      id: "a2",
      userId: "u2",
      side: "sell",
      price: 100n,
      quantity: 3n,
    });
    engine.submit({
      type: "limit",
      id: "a3",
      userId: "u3",
      side: "sell",
      price: 100n,
      quantity: 4n,
    });
    engine.submit({ type: "limit", id: "b1", userId: "u4", side: "buy", price: 99n, quantity: 2n });
    // Takes 1 of a2, which keeps its place ahead of a3.
    engine.submit({
      type: "limit",
      id: "b2",
      userId: "u4",
      side: "buy",
      price: 100n,
      quantity: 1n,
    });

    expect(JSON.parse(serializeEngine(engine))).toEqual({
      version: 1,
      sequence: 5,
      bids: [{ price: "99", orders: [{ id: "b1", userId: "u4", remaining: "2" }] }],
      asks: [
        {
          price: "100",
          orders: [
            { id: "a2", userId: "u2", remaining: "2" },
            { id: "a3", userId: "u3", remaining: "4" },
          ],
        },
        { price: "101", orders: [{ id: "a1", userId: "u1", remaining: "5" }] },
      ],
    });
  });
});

describe("snapshots while a market trades", () => {
  it("writes one each interval, exact at its sequence", async () => {
    const market = await testMarket("BTC-USD");
    const seller = await funded({ BTC: "10" });
    const buyer = await funded({ USD: "1000000" });
    const exchange = new Exchange(db, { snapshotEvery: 4 });
    const written: number[] = [];
    exchange.onSnapshot((_market, sequence, error) => {
      expect(error).toBeUndefined();
      written.push(sequence);
    });

    // 1-3: three asks rest. 4-5: a bid takes all of the first and half of the second. 6: a bid
    // rests, 7: and is cancelled. 8-9: a market buy takes the rest of the second and part of
    // the third. 10: a bid rests.
    await exchange.placeOrder(market, limit(seller, "sell", "60000", "0.1"));
    await exchange.placeOrder(market, limit(seller, "sell", "60000", "0.2"));
    await exchange.placeOrder(market, limit(seller, "sell", "60100", "0.3"));
    await exchange.placeOrder(market, limit(buyer, "buy", "60000", "0.15"));
    const bid = await exchange.placeOrder(market, limit(buyer, "buy", "59000", "0.1"));
    await exchange.cancelOrder(market, bid.id);
    await exchange.placeOrder(market, {
      type: "market",
      userId: buyer,
      side: "buy",
      quantity: units("0.25"),
    });
    await exchange.placeOrder(market, limit(buyer, "buy", "59500", "0.1"));
    // Waits for the writes still in flight.
    await exchange.close();

    // After the first command to reach each multiple of 4: the bid ending at 5, then the
    // market buy ending at 9.
    const rows = await snapshotsOf(market.symbol);
    expect(rows.map((row) => row.sequence)).toEqual(written);
    expect(written).toEqual([5, 9]);
    // Each one is what a replay of the log up to its sequence leaves.
    const log = await readLog(db, market.symbol);
    for (const row of rows) {
      const engine = new Engine(market.symbol);
      replay(
        engine,
        log.filter((entry) => entry.sequence <= row.sequence),
      );
      expect(engine.sequence).toBe(row.sequence);
      expect(row.book).toEqual(JSON.parse(serializeEngine(engine)));
    }
  });

  it("reports a failed write, keeps trading and writes the next one", async () => {
    const market = await testMarket("BTC-USD");
    const seller = await funded({ BTC: "10" });
    // A row already at 3 makes the first snapshot's insert fail on the primary key.
    await db.insert(bookSnapshots).values({ market: market.symbol, sequence: 3, book: {} });
    const exchange = new Exchange(db, { snapshotEvery: 3 });
    const reports: { sequence: number; failed: boolean }[] = [];
    exchange.onSnapshot((_market, sequence, error) => {
      reports.push({ sequence, failed: error !== undefined });
    });

    // Each ask rests in one event, so the snapshots fall at 3 and 6.
    for (const price of ["60000", "60100", "60200", "60300", "60400", "60500"]) {
      await expect(
        exchange.placeOrder(market, limit(seller, "sell", price, "0.1")),
      ).resolves.toMatchObject({ status: "open" });
    }
    await exchange.close();

    expect(reports).toEqual([
      { sequence: 3, failed: true },
      { sequence: 6, failed: false },
    ]);
    expect(exchange.isHalted(market.symbol)).toBe(false);
    expect((await snapshotsOf(market.symbol)).map((row) => row.sequence)).toEqual([3, 6]);
  });
});
