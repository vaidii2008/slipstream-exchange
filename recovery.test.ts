import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { appendCommand, readLog, replay, takerLimitOf } from "./events.ts";
import { Engine } from "./engine.ts";
import { Exchange } from "./exchange.ts";
import { balancesOf, deposit } from "./ledger.ts";
import { parseAmount } from "./money.ts";
import { type Market, recordOrder } from "./orders.ts";
import { orders, trades, users } from "./schema.ts";
import { settle } from "./settlement.ts";
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
    .values({ email: uniqueEmail("recovery-test"), passwordHash: "not-a-real-hash" })
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

async function balance(userId: string, asset: string) {
  const row = (await balancesOf(db, userId)).find((b) => b.asset === asset);
  return { available: row?.available ?? 0n, reserved: row?.reserved ?? 0n };
}

async function statusOf(orderId: string) {
  const [row] = await db
    .select({ status: orders.status, filled: orders.filledQuantity })
    .from(orders)
    .where(eq(orders.id, orderId));
  return row;
}

async function ledgerTotals() {
  const totals = await db.execute<{ asset: string; total: string }>(sql`
    select a.asset, sum(e.amount)::text as total
    from ledger_entries e join ledger_accounts a on a.id = e.account_id
    group by a.asset`);
  return totals.rows.map((row) => ({ asset: row.asset, total: Number(row.total) }));
}

// What the exchange does for an order up to the log write, and no further: reserve and
// record it, then append its command, as if the process died before applying it.
async function loggedButNotSettled(
  market: Market,
  sequence: number,
  order: ReturnType<typeof limit>,
) {
  const { id } = await recordOrder(db, market, order);
  await appendCommand(db, market.symbol, sequence, { type: "submit", order: { ...order, id } });
  return id;
}

describe("recovery when a market opens", () => {
  it("settles a command that was logged but not settled", async () => {
    const market = await testMarket("BTC-USD");
    const seller = await funded({ BTC: "1" });
    const buyer = await funded({ USD: "100000" });
    const before = new Exchange(db);
    const ask = await before.placeOrder(market, limit(seller, "sell", "60000", "0.1"));
    // The buy crosses the ask: a trade at 2 and the rest resting at 3, none of it settled.
    const bid = await loggedButNotSettled(market, 2, limit(buyer, "buy", "60500", "0.3"));

    const after = new Exchange(db);
    await expect(after.open([market])).resolves.toEqual([
      { market: market.symbol, sequence: 3, halted: false, settled: 1, cancelled: 0 },
    ]);

    await expect(statusOf(ask.id)).resolves.toEqual({
      status: "filled",
      filled: "0.100000000000000000",
    });
    await expect(statusOf(bid)).resolves.toEqual({
      status: "open",
      filled: "0.100000000000000000",
    });
    const [trade] = await db
      .select({ sequence: trades.engineSequence, price: trades.price })
      .from(trades)
      .where(eq(trades.market, market.symbol));
    expect(trade).toEqual({ sequence: 2, price: "60000.000000000000000000" });
    // The buyer paid 6,000 at the maker's price, got the 50 of price improvement back, and
    // still has 0.2 × 60,500 reserved for the resting rest.
    await expect(balance(buyer, "USD")).resolves.toEqual({
      available: units("81900"),
      reserved: units("12100"),
    });
    await expect(balance(buyer, "BTC")).resolves.toEqual({ available: units("0.1"), reserved: 0n });
    await expect(balance(seller, "USD")).resolves.toEqual({
      available: units("6000"),
      reserved: 0n,
    });
    expect(after.depth(market.symbol, 10)).toEqual({
      sequence: 3,
      bids: [{ price: units("60500"), quantity: units("0.2") }],
      asks: [],
    });
    for (const { total } of await ledgerTotals()) {
      expect(total).toBe(0);
    }
  });

  it("cancels orders that never reached the log and releases what they reserved", async () => {
    const market = await testMarket("BTC-USD");
    const seller = await funded({ BTC: "1" });
    const buyer = await funded({ USD: "100000" });
    const exchange = new Exchange(db);
    await exchange.placeOrder(market, limit(seller, "sell", "60000", "0.1"));
    // Reserved and recorded, then the process died before the log write.
    const sell = await recordOrder(db, market, limit(seller, "sell", "61000", "0.2"));
    const buy = await recordOrder(db, market, {
      type: "market",
      userId: buyer,
      side: "buy",
      quantity: units("0.1"),
      protectionPrice: units("63000"),
    });
    await expect(balance(buyer, "USD")).resolves.toEqual({
      available: units("93700"),
      reserved: units("6300"),
    });

    const after = new Exchange(db);
    await expect(after.open([market])).resolves.toEqual([
      { market: market.symbol, sequence: 1, halted: false, settled: 0, cancelled: 2 },
    ]);

    await expect(statusOf(sell.id)).resolves.toMatchObject({ status: "cancelled" });
    await expect(statusOf(buy.id)).resolves.toMatchObject({ status: "cancelled" });
    await expect(balance(buyer, "USD")).resolves.toEqual({
      available: units("100000"),
      reserved: 0n,
    });
    // Only the logged ask still holds BTC.
    await expect(balance(seller, "BTC")).resolves.toEqual({
      available: units("0.9"),
      reserved: units("0.1"),
    });
    expect(after.depth(market.symbol, 10).asks).toEqual([
      { price: units("60000"), quantity: units("0.1") },
    ]);
  });

  it("changes nothing when it runs again", async () => {
    const market = await testMarket("BTC-USD");
    const seller = await funded({ BTC: "1" });
    const buyer = await funded({ USD: "100000" });
    const first = new Exchange(db);
    await first.placeOrder(market, limit(seller, "sell", "60000", "0.1"));
    await loggedButNotSettled(market, 2, limit(buyer, "buy", "60000", "0.05"));
    await recordOrder(db, market, limit(buyer, "buy", "59000", "0.1"));
    await expect(new Exchange(db).open([market])).resolves.toMatchObject([
      { settled: 1, cancelled: 1 },
    ]);
    const balances = await Promise.all([balancesOf(db, seller), balancesOf(db, buyer)]);
    const rows = await db
      .select({ id: orders.id, status: orders.status, filled: orders.filledQuantity })
      .from(orders)
      .where(eq(orders.market, market.symbol));

    const again = new Exchange(db);
    await expect(again.open([market])).resolves.toEqual([
      { market: market.symbol, sequence: 2, halted: false, settled: 0, cancelled: 0 },
    ]);

    await expect(Promise.all([balancesOf(db, seller), balancesOf(db, buyer)])).resolves.toEqual(
      balances,
    );
    await expect(
      db
        .select({ id: orders.id, status: orders.status, filled: orders.filledQuantity })
        .from(orders)
        .where(eq(orders.market, market.symbol)),
    ).resolves.toEqual(expect.arrayContaining(rows));
    expect(again.depth(market.symbol, 10).asks).toEqual([
      { price: units("60000"), quantity: units("0.05") },
    ]);
  });

  it("halts a market whose rebuilt book disagrees with Postgres", async () => {
    const market = await testMarket("BTC-USD");
    const seller = await funded({ BTC: "1" });
    const exchange = new Exchange(db);
    const ask = await exchange.placeOrder(market, limit(seller, "sell", "60000", "0.1"));
    // Behind the log's back, the database says the ask is a third filled.
    await db.update(orders).set({ filledQuantity: "0.03" }).where(eq(orders.id, ask.id));

    const after = new Exchange(db);
    const halts: unknown[] = [];
    after.onHalt((_symbol, error) => halts.push(error));

    await expect(after.open([market])).resolves.toMatchObject([{ halted: true }]);
    expect(halts).toEqual([
      expect.objectContaining({
        message: expect.stringContaining(`[${ask.id}]`) as unknown,
      }),
    ]);
  });
});

describe("a trade's engine sequence", () => {
  it("is unique per market, so settling a command twice fails and writes nothing", async () => {
    const market = await testMarket("BTC-USD");
    const seller = await funded({ BTC: "1" });
    const buyer = await funded({ USD: "100000" });
    const exchange = new Exchange(db);
    // Orders that stay resting keep BTC and USD reserved, so a second settlement's ledger
    // postings would find enough to debit: only the trade's sequence stops it.
    await exchange.placeOrder(market, limit(seller, "sell", "70000", "0.5"));
    await exchange.placeOrder(market, limit(buyer, "buy", "50000", "0.2"));
    await exchange.placeOrder(market, limit(seller, "sell", "60000", "0.1"));
    await exchange.placeOrder(market, limit(buyer, "buy", "60000", "0.1"));
    const log = await readLog(db, market.symbol);
    const replayed = replay(new Engine(market.symbol), log);
    const before = await Promise.all([balancesOf(db, seller), balancesOf(db, buyer)]);

    // The buy's command, settled already, settled again as a wrong frontier would.
    await expect(
      settle(db, market, replayed[3]!, takerLimitOf(log[3]!.command), new Date()),
    ).rejects.toMatchObject({ cause: expect.objectContaining({ code: "23505" }) as unknown });

    await expect(Promise.all([balancesOf(db, seller), balancesOf(db, buyer)])).resolves.toEqual(
      before,
    );
    await expect(
      db.select({ id: trades.id }).from(trades).where(eq(trades.market, market.symbol)),
    ).resolves.toHaveLength(1);
  });
});
