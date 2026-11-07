import { spawn } from "node:child_process";
import { and, eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { appendCommand, readLog, replay, takerLimitOf } from "./events.ts";
import { Engine } from "./engine.ts";
import { Exchange } from "./exchange.ts";
import { balancesOf, deposit, openAccount } from "./ledger.ts";
import { fromNumeric, notional, parseAmount } from "./money.ts";
import { type Market, recordOrder } from "./orders.ts";
import { orders, trades, users } from "./schema.ts";
import { settle } from "./settlement.ts";
import { testDatabaseUrl } from "./testdb.ts";
import { useTestServer } from "./testing.ts";

const { pool, db, uniqueEmail, testMarket } = useTestServer();

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
      { market: market.symbol, sequence: 3, halted: false, replayed: 2, settled: 1, cancelled: 0 },
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
      { market: market.symbol, sequence: 1, halted: false, replayed: 1, settled: 0, cancelled: 2 },
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
      { market: market.symbol, sequence: 2, halted: false, replayed: 2, settled: 0, cancelled: 0 },
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

  it("does not count a rejected cancel after the frontier as a settlement", async () => {
    const market = await testMarket("BTC-USD");
    const seller = await funded({ BTC: "1" });
    await new Exchange(db).placeOrder(market, limit(seller, "sell", "60000", "0.1"));
    // A cancel of an order that is not resting: one rejected event, nothing to write.
    await appendCommand(db, market.symbol, 2, { type: "cancel", orderId: "already-gone" });

    await expect(new Exchange(db).open([market])).resolves.toEqual([
      { market: market.symbol, sequence: 2, halted: false, replayed: 2, settled: 0, cancelled: 0 },
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
  it("halts a market where Postgres has an open order the rebuilt book does not", async () => {
    const market = await testMarket("BTC-USD");
    const seller = await funded({ BTC: "1" });
    const buyer = await funded({ USD: "100000" });
    const exchange = new Exchange(db);
    await exchange.placeOrder(market, limit(seller, "sell", "60000", "0.1"));
    const bid = await exchange.placeOrder(market, limit(buyer, "buy", "60000", "0.1"));
    // Behind the log's back, the database says the filled bid is still open.
    await db.update(orders).set({ status: "open" }).where(eq(orders.id, bid.id));

    const after = new Exchange(db);
    const halts: unknown[] = [];
    after.onHalt((_symbol, error) => halts.push(error));

    await expect(after.open([market])).resolves.toMatchObject([{ halted: true }]);
    expect(halts).toEqual([
      expect.objectContaining({
        message: expect.stringContaining(`open there but not resting [${bid.id}]`) as unknown,
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

// A book as the child prints it and as depth() returns it, compared as decimal strings.
type Book = { sequence: number; bids: Level[]; asks: Level[] };
type Level = { price: string; quantity: string };
const printed = (book: { sequence: number; bids: unknown[]; asks: unknown[] }): Book =>
  JSON.parse(
    JSON.stringify(book, (_, value: unknown) =>
      typeof value === "bigint" ? String(value) : value,
    ),
  ) as Book;

// Resolves once `check` passes, polling every 20 ms. The ceiling is generous because each
// condition depends on how busy Postgres is: straight after a load run on the same server, a
// 10 s ceiling was passed. A passing run returns as soon as its condition holds, so the
// ceiling only bounds how long a failing run takes to say so.
const WAIT_CEILING_MS = 60_000;

async function until(what: string, check: () => Promise<boolean> | boolean): Promise<void> {
  const startedAt = Date.now();
  while (!(await check())) {
    if (Date.now() - startedAt > WAIT_CEILING_MS) {
      throw new Error(`timed out after ${WAIT_CEILING_MS} ms waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("a process killed mid-load", () => {
  it(
    "leaves a log that rebuilds its book, finishes its settlement and balances",
    async () => {
      const market = await testMarket("BTC-USD");
      const userIds: string[] = [];
      for (let i = 0; i < 6; i++) {
        const userId = await funded({ USD: "100000000", BTC: "10000" });
        // Every account settlement can debit exists before the lock below is taken.
        for (const asset of ["USD", "BTC"]) {
          await openAccount(db, userId, asset, "reserved");
        }
        userIds.push(userId);
      }

      const child = spawn(
        process.execPath,
        ["recovery.child.ts", market.symbol, JSON.stringify(userIds)],
        {
          env: { ...process.env, DATABASE_URL: testDatabaseUrl() },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      const books: Book[] = [];
      let partial = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        const lines = (partial + chunk).split("\n");
        partial = lines.pop() ?? "";
        books.push(...lines.map((line) => JSON.parse(line) as Book));
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      let exited = false;
      const exit = new Promise<NodeJS.Signals | number | null>((resolve) => {
        child.on("exit", (code, signal) => {
          exited = true;
          resolve(signal ?? code);
        });
      });

      const lock = await pool.connect();
      try {
        await until("the load process to report 300 commands", () => {
          if (exited) {
            throw new Error(`the load process exited early: ${stderr}`);
          }
          return books.length >= 300;
        });

        // Hold every user's BTC available account. A settlement locks every account it touches,
        // and every trade credits the buyer's BTC available, so the next command that trades
        // (or cancels a sell) is logged and applied, then its settlement waits here. A buy
        // reserves USD, which is not held, so buys are reserved and recorded behind it and
        // wait in the queue without being logged.
        await lock.query("begin");
        await lock.query(
          `select id from ledger_accounts
           where user_id = any($1) and asset = 'BTC' and bucket = 'available' for update`,
          [userIds],
        );
        const holder = await lock.query<{ xid: string }>("select txid_current()::text as xid");
        await until("a settlement to wait on the held accounts", async () => {
          const waiting = await pool.query<{ n: number }>(
            `select count(*)::int as n from pg_locks
           where locktype = 'transactionid' and not granted and transactionid::text = $1`,
            [holder.rows[0]?.xid],
          );
          return (waiting.rows[0]?.n ?? 0) > 0;
        });
        const logged = async () =>
          (await readLog(db, market.symbol)).map((entry) => entry.sequence);
        // Wait for orders the log has not seen: pending, and not the blocked command's own.
        await until("an order reserved behind the blocked settlement", async () => {
          const ids = new Set(
            (await readLog(db, market.symbol)).flatMap((entry) =>
              entry.command.type === "submit" ? [entry.command.order.id] : [],
            ),
          );
          const pending = await db
            .select({ id: orders.id })
            .from(orders)
            .where(and(eq(orders.market, market.symbol), eq(orders.status, "pending")));
          return pending.some((order) => !ids.has(order.id));
        });

        child.kill("SIGKILL");
        await expect(exit).resolves.toBe("SIGKILL");
        expect((await logged()).at(-1)).toBe(books.at(-1)!.sequence + 1);
      } finally {
        child.kill("SIGKILL");
        await lock.query("rollback");
        lock.release();
      }

      // The process died between logging a command and settling it, with other orders reserved
      // and never logged.
      const log = await readLog(db, market.symbol);
      const loggedIds = new Set(
        log.flatMap((entry) => (entry.command.type === "submit" ? [entry.command.order.id] : [])),
      );
      const pendingBefore = await db
        .select({ id: orders.id })
        .from(orders)
        .where(and(eq(orders.market, market.symbol), eq(orders.status, "pending")));
      const unlogged = pendingBefore.filter((order) => !loggedIds.has(order.id));
      expect(unlogged.length).toBeGreaterThan(0);

      // The log up to the last command the process reported rebuilds exactly the book it had.
      const last = books.at(-1)!;
      const prefix = new Engine(market.symbol);
      replay(
        prefix,
        log.filter((entry) => entry.sequence <= last.sequence),
      );
      expect(printed(prefix.depth(100_000))).toEqual(last);

      // A new process opens the market: it settles the interrupted command and cancels the
      // orders that never reached the log.
      const after = new Exchange(db);
      await expect(after.open([market])).resolves.toEqual([
        {
          market: market.symbol,
          sequence:
            log.at(-1)!.sequence + replay(new Engine(market.symbol), log).at(-1)!.length - 1,
          halted: false,
          replayed: log.length,
          settled: 1,
          cancelled: unlogged.length,
        },
      ]);

      // Nothing is left pending, and the rebuilt book is the open orders in Postgres.
      const rows = await db
        .select({
          userId: orders.userId,
          side: orders.side,
          price: orders.price,
          quantity: orders.quantity,
          filled: orders.filledQuantity,
          status: orders.status,
        })
        .from(orders)
        .where(eq(orders.market, market.symbol));
      expect(rows.filter((row) => row.status === "pending")).toEqual([]);
      const open = rows
        .filter((row) => row.status === "open")
        .map((row) => ({
          userId: row.userId,
          side: row.side,
          price: fromNumeric(row.price!, 8),
          remaining: fromNumeric(row.quantity, 8) - fromNumeric(row.filled, 8),
        }));
      const levels = (side: "buy" | "sell") => {
        const totals = new Map<bigint, bigint>();
        for (const order of open.filter((o) => o.side === side)) {
          totals.set(order.price, (totals.get(order.price) ?? 0n) + order.remaining);
        }
        return [...totals]
          .sort(([a], [b]) => (side === "buy" ? (a > b ? -1 : 1) : a < b ? -1 : 1))
          .map(([price, quantity]) => ({ price, quantity }));
      };
      const rebuilt = after.depth(market.symbol, 100_000);
      expect(rebuilt.bids).toEqual(levels("buy"));
      expect(rebuilt.asks).toEqual(levels("sell"));

      // Every asset still sums to zero, and each user's reserved balance is exactly what their
      // open orders hold: nothing the crash interrupted is left stranded.
      for (const { total } of await ledgerTotals()) {
        expect(total).toBe(0);
      }
      for (const userId of userIds) {
        const mine = open.filter((order) => order.userId === userId);
        const held = (side: "buy" | "sell") => mine.filter((order) => order.side === side);
        await expect(balance(userId, "BTC")).resolves.toMatchObject({
          reserved: held("sell").reduce((sum, order) => sum + order.remaining, 0n),
        });
        await expect(balance(userId, "USD")).resolves.toMatchObject({
          reserved: held("buy").reduce(
            (sum, order) => sum + notional(order.price, order.remaining, 8),
            0n,
          ),
        });
      }

      // And the market trades on from where the log ends.
      const next = await after.placeOrder(market, limit(userIds[0]!, "buy", "50000", "0.001"));
      expect(next.status).toBe("open");
      expect(after.depth(market.symbol, 1).sequence).toBe(rebuilt.sequence + 1);
      // Three waits at their ceiling, plus the replay and checks after them.
    },
    4 * WAIT_CEILING_MS,
  );
});
