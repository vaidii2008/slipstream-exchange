import { and, asc, eq } from "drizzle-orm";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { Engine, type NewOrder } from "./engine.ts";
import { applyCommand, type LoggedCommand, readLog, replay } from "./events.ts";
import { Exchange } from "./exchange.ts";
import { deposit } from "./ledger.ts";
import { parseAmount } from "./money.ts";
import { bookSnapshots, engineEvents, users } from "./schema.ts";
import { decodeSnapshot, serializeEngine } from "./snapshots.ts";
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

describe("opening a market from its snapshots", () => {
  // Nine resting asks, one event each, with snapshots at 3, 6 and 9, then a bid that trades
  // with the best ask at 10 and an ask that rests at 11.
  async function trade(symbol: Awaited<ReturnType<typeof testMarket>>) {
    const seller = await funded({ BTC: "10" });
    const buyer = await funded({ USD: "1000000" });
    const exchange = new Exchange(db, { snapshotEvery: 3 });
    for (let i = 0; i < 9; i++) {
      await exchange.placeOrder(symbol, limit(seller, "sell", String(60_000 + 10 * i), "0.1"));
    }
    await exchange.placeOrder(symbol, limit(buyer, "buy", "60000", "0.05"));
    await exchange.placeOrder(symbol, limit(seller, "sell", "60000", "0.1"));
    await exchange.close();
    return exchange.depth(symbol.symbol, 50);
  }

  it("starts from the latest snapshot and replays only the commands after it", async () => {
    const market = await testMarket("BTC-USD");
    const book = await trade(market);
    expect((await snapshotsOf(market.symbol)).map((row) => row.sequence)).toEqual([3, 6, 9]);

    const after = new Exchange(db);
    await expect(after.open([market])).resolves.toEqual([
      {
        market: market.symbol,
        sequence: 11,
        halted: false,
        restoredFrom: 9,
        replayed: 2,
        settled: 0,
        cancelled: 0,
      },
    ]);
    expect(after.depth(market.symbol, 50)).toEqual(book);
  });

  it("falls back past snapshots that do not read, then to the whole log", async () => {
    const market = await testMarket("BTC-USD");
    const book = await trade(market);
    const corrupt = (sequence: number, book: unknown) =>
      db
        .update(bookSnapshots)
        .set({ book })
        .where(and(eq(bookSnapshots.market, market.symbol), eq(bookSnapshots.sequence, sequence)));
    // 9 is in a format nobody wrote; 6 decodes but holds a crossed book.
    await corrupt(9, { version: 99 });
    const crossed = {
      version: 1,
      sequence: 6,
      bids: [{ price: "7000000000000", orders: [{ id: "x", userId: "y", remaining: "1" }] }],
      asks: [{ price: "6000000000000", orders: [{ id: "z", userId: "y", remaining: "1" }] }],
    };
    await corrupt(6, crossed);

    const partly = new Exchange(db);
    const skipped: number[] = [];
    partly.onSnapshotSkipped((_market, sequence) => skipped.push(sequence));
    await expect(partly.open([market])).resolves.toMatchObject([
      { sequence: 11, halted: false, restoredFrom: 3, replayed: 8 },
    ]);
    expect(skipped).toEqual([9, 6]);
    expect(partly.depth(market.symbol, 50)).toEqual(book);

    await corrupt(3, "not a snapshot");
    const fully = new Exchange(db);
    await expect(fully.open([market])).resolves.toMatchObject([
      { sequence: 11, halted: false, restoredFrom: 0, replayed: 11 },
    ]);
    expect(fully.depth(market.symbol, 50)).toEqual(book);
  });

  it("halts a market whose log is missing the command right after its snapshot", async () => {
    const market = await testMarket("BTC-USD");
    await trade(market);
    await db
      .delete(engineEvents)
      .where(and(eq(engineEvents.market, market.symbol), eq(engineEvents.sequence, 10)));

    const after = new Exchange(db);
    const halts: unknown[] = [];
    after.onHalt((_market, error) => halts.push(error));
    await expect(after.open([market])).resolves.toMatchObject([
      { halted: true, restoredFrom: 9, replayed: 0 },
    ]);
    expect(halts).toEqual([
      expect.objectContaining({ message: "event log has command 11 where 10 was next" }),
    ]);
  });
});

// Engine-only, like engine.property.test.ts: three users and a narrow band, so orders cross,
// rest, self-trade and get cancelled often.
type Generated =
  | { kind: "limit"; userId: string; side: "buy" | "sell"; price: bigint; quantity: bigint }
  | { kind: "market"; userId: string; side: "buy" | "sell"; quantity: bigint }
  | { kind: "cancel"; target: number };

const userId = fc.constantFrom("alice", "bob", "carol");
const side = fc.constantFrom<"buy" | "sell">("buy", "sell");
const generated: fc.Arbitrary<Generated> = fc.oneof(
  {
    weight: 6,
    arbitrary: fc.record({
      kind: fc.constant("limit"),
      userId,
      side,
      price: fc.bigInt({ min: 95n, max: 105n }),
      quantity: fc.bigInt({ min: 1n, max: 20n }),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant("market"),
      userId,
      side,
      quantity: fc.bigInt({ min: 1n, max: 20n }),
    }),
  },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("cancel"), target: fc.nat() }) },
);

// The log a market with these commands would have: each numbered by its first event.
function logOf(commands: Generated[]): LoggedCommand[] {
  const engine = new Engine("PROP");
  const ids: string[] = [];
  return commands.map((next) => {
    const sequence = engine.sequence + 1;
    let command: LoggedCommand["command"];
    if (next.kind === "cancel") {
      command = { type: "cancel", orderId: ids[next.target % Math.max(ids.length, 1)] ?? "none" };
    } else {
      const id = `o${ids.length + 1}`;
      ids.push(id);
      const order: NewOrder =
        next.kind === "limit"
          ? {
              type: "limit",
              id,
              userId: next.userId,
              side: next.side,
              price: next.price,
              quantity: next.quantity,
            }
          : { type: "market", id, userId: next.userId, side: next.side, quantity: next.quantity };
      command = { type: "submit", order };
    }
    applyCommand(engine, command);
    return { sequence, command, loggedAt: new Date(0) };
  });
}

// Pure CPU, 300 runs: a few seconds alone, which can pass Vitest's 5 s default when the whole
// suite shares the machine, as in engine.property.test.ts.
describe("a snapshot plus the rest of the log", { timeout: 30_000 }, () => {
  it("rebuilds exactly what a full replay does, wherever the snapshot was cut", () => {
    fc.assert(
      fc.property(
        fc.array(generated, { maxLength: 200, size: "large" }),
        fc.nat(),
        (commands, at) => {
          const log = logOf(commands);
          const cut = at % (log.length + 1);
          const full = new Engine("PROP");
          const fullEvents = replay(full, log);

          const before = new Engine("PROP");
          replay(before, log.slice(0, cut));
          // Through the stored form: text, parsed as Postgres would hand it back, decoded.
          const stored: unknown = JSON.parse(serializeEngine(before));
          const restored = Engine.restore("PROP", decodeSnapshot(stored, before.sequence));
          const restEvents = replay(restored, log.slice(cut));

          expect(restEvents).toEqual(fullEvents.slice(cut));
          expect(restored.sequence).toBe(full.sequence);
          expect(restored.snapshot()).toEqual(full.snapshot());
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe("pruning", () => {
  it("keeps only the newest three snapshots of a market", async () => {
    const market = await testMarket("BTC-USD");
    const other = await testMarket("BTC-USD");
    const seller = await funded({ BTC: "10" });
    const exchange = new Exchange(db, { snapshotEvery: 1 });
    // A snapshot after every resting ask: 1 to 6 in one market, 1 to 2 in the other.
    for (let i = 0; i < 6; i++) {
      await exchange.placeOrder(market, limit(seller, "sell", String(60_000 + 10 * i), "0.1"));
    }
    for (let i = 0; i < 2; i++) {
      await exchange.placeOrder(other, limit(seller, "sell", String(60_000 + 10 * i), "0.1"));
    }
    await exchange.close();

    expect((await snapshotsOf(market.symbol)).map((row) => row.sequence)).toEqual([4, 5, 6]);
    expect((await snapshotsOf(other.symbol)).map((row) => row.sequence)).toEqual([1, 2]);
  });
});
