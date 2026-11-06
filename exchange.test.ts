import { eq, sql } from "drizzle-orm";
import { setTimeout as delay } from "node:timers/promises";
import { beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Exchange, MarketBusyError, SerialQueue } from "./exchange.ts";
import { balancesOf, deposit, openAccount } from "./ledger.ts";
import { parseAmount } from "./money.ts";
import { loadMarket, type Market } from "./orders.ts";
import { orders, trades, users } from "./schema.ts";
import { useTestServer } from "./testing.ts";

const { pool, db, uniqueEmail } = useTestServer();

// Every amount in these tests is written as the decimal a client would send.
const units = (value: string, scale = 8): bigint => {
  const parsed = parseAmount(value, scale);
  if (!parsed.ok) {
    throw new Error(`bad test amount ${value}: ${parsed.reason}`);
  }
  return parsed.units;
};

async function createUser(): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({ email: uniqueEmail("exchange-test"), passwordHash: "not-a-real-hash" })
    .returning({ id: users.id });
  if (user === undefined) {
    throw new Error("user insert returned no row");
  }
  return user.id;
}

async function balanceOf(userId: string, asset: string) {
  const balance = (await balancesOf(db, userId)).find((row) => row.asset === asset);
  return { available: balance?.available, reserved: balance?.reserved };
}

let btcUsd: Market;
let ethUsd: Market;

beforeAll(async () => {
  const [btc, eth] = await Promise.all([loadMarket(db, "BTC-USD"), loadMarket(db, "ETH-USD")]);
  if (btc === undefined || eth === undefined) {
    throw new Error("BTC-USD and ETH-USD must be seeded");
  }
  btcUsd = btc;
  ethUsd = eth;
});

describe("SerialQueue", () => {
  it("runs one task at a time, in the order they were added, even when earlier ones are slower", async () => {
    const queue = new SerialQueue();
    const log: string[] = [];
    let running = 0;
    let mostAtOnce = 0;

    const task = (name: string, ms: number) => async () => {
      running++;
      mostAtOnce = Math.max(mostAtOnce, running);
      log.push(`start ${name}`);
      await delay(ms);
      log.push(`end ${name}`);
      running--;
      return name;
    };

    const results = await Promise.all([
      queue.run(task("a", 30)),
      queue.run(task("b", 1)),
      queue.run(task("c", 10)),
    ]);

    expect(results).toEqual(["a", "b", "c"]);
    expect(mostAtOnce).toBe(1);
    expect(log).toEqual(["start a", "end a", "start b", "end b", "start c", "end c"]);
  });

  it("rejects only the failing task's caller and carries on with the next", async () => {
    const queue = new SerialQueue();

    const failing = queue.run(() => Promise.reject(new Error("settlement failed")));
    const throwing = queue.run(() => {
      throw new Error("threw before returning a promise");
    });
    const next = queue.run(() => Promise.resolve("still ran"));

    await expect(failing).rejects.toThrow("settlement failed");
    await expect(throwing).rejects.toThrow("threw before returning a promise");
    await expect(next).resolves.toBe("still ran");
  });
});

describe("Exchange.placeOrder", () => {
  // A fresh exchange per test, so every test starts from empty books.
  async function funded(holdings: Record<string, string>): Promise<string> {
    const userId = await createUser();
    for (const [asset, amount] of Object.entries(holdings)) {
      await deposit(db, userId, asset, units(amount));
    }
    return userId;
  }

  const limit = (userId: string, side: "buy" | "sell", price: string, quantity: string) => ({
    type: "limit" as const,
    userId,
    side,
    price: units(price),
    quantity: units(quantity),
  });

  async function orderRow(id: string) {
    const [row] = await db
      .select({
        status: orders.status,
        filledQuantity: orders.filledQuantity,
        engineSequence: orders.engineSequence,
      })
      .from(orders)
      .where(eq(orders.id, id));
    return row;
  }

  it("rests an order that crosses nothing and keeps its reservation", async () => {
    const exchange = new Exchange(db);
    const buyer = await funded({ USD: "30000" });

    const placed = await exchange.placeOrder(btcUsd, limit(buyer, "buy", "60000", "0.5"));

    expect(placed).toEqual({ id: placed.id, status: "open", filledQuantity: 0n, fills: [] });
    await expect(orderRow(placed.id)).resolves.toEqual({
      status: "open",
      filledQuantity: "0.000000000000000000",
      engineSequence: 1,
    });
    await expect(balanceOf(buyer, "USD")).resolves.toEqual({
      available: 0n,
      reserved: units("30000"),
    });
  });

  it("fills at the maker's price, settles both sides and refunds the buyer's improvement", async () => {
    const exchange = new Exchange(db);
    const seller = await funded({ BTC: "1" });
    const buyer = await funded({ USD: "30050" });

    const sell = await exchange.placeOrder(btcUsd, limit(seller, "sell", "60000", "0.5"));
    const buy = await exchange.placeOrder(btcUsd, limit(buyer, "buy", "60100", "0.5"));

    expect(buy).toEqual({
      id: buy.id,
      status: "filled",
      filledQuantity: units("0.5"),
      fills: [{ price: units("60000"), quantity: units("0.5") }],
    });
    // The buyer reserved 0.5 × 60,100 = 30,050 and paid 0.5 × 60,000 = 30,000.
    await expect(balanceOf(buyer, "USD")).resolves.toEqual({
      available: units("50"),
      reserved: 0n,
    });
    await expect(balanceOf(buyer, "BTC")).resolves.toEqual({
      available: units("0.5"),
      reserved: 0n,
    });
    await expect(balanceOf(seller, "BTC")).resolves.toEqual({
      available: units("0.5"),
      reserved: 0n,
    });
    await expect(balanceOf(seller, "USD")).resolves.toEqual({
      available: units("30000"),
      reserved: 0n,
    });
    await expect(orderRow(sell.id)).resolves.toMatchObject({ status: "filled" });
    await expect(orderRow(buy.id)).resolves.toMatchObject({ status: "filled" });

    const recorded = await db
      .select({
        makerOrderId: trades.makerOrderId,
        takerOrderId: trades.takerOrderId,
        price: trades.price,
        quantity: trades.quantity,
      })
      .from(trades)
      .where(eq(trades.takerOrderId, buy.id));
    expect(recorded).toEqual([
      {
        makerOrderId: sell.id,
        takerOrderId: buy.id,
        price: "60000.000000000000000000",
        quantity: "0.500000000000000000",
      },
    ]);
  });

  it("fills part of an order and rests the rest, still reserved at its own limit", async () => {
    const exchange = new Exchange(db);
    const seller = await funded({ BTC: "0.2" });
    const buyer = await funded({ USD: "30000" });

    const sell = await exchange.placeOrder(btcUsd, limit(seller, "sell", "60000", "0.2"));
    const buy = await exchange.placeOrder(btcUsd, limit(buyer, "buy", "60000", "0.5"));

    expect(buy).toMatchObject({ status: "open", filledQuantity: units("0.2") });
    await expect(orderRow(buy.id)).resolves.toEqual({
      status: "open",
      filledQuantity: "0.200000000000000000",
      engineSequence: 3,
    });
    await expect(orderRow(sell.id)).resolves.toMatchObject({ status: "filled" });
    // 0.3 left at 60,000 is 18,000 still reserved; 12,000 went to the seller.
    await expect(balanceOf(buyer, "USD")).resolves.toEqual({
      available: 0n,
      reserved: units("18000"),
    });
    await expect(balanceOf(seller, "USD")).resolves.toEqual({
      available: units("12000"),
      reserved: 0n,
    });
  });

  it("sweeps several makers best price first and pays each at their own price", async () => {
    const exchange = new Exchange(db);
    const high = await funded({ USD: "600" });
    const low = await funded({ USD: "599" });
    const seller = await funded({ BTC: "0.02" });

    await exchange.placeOrder(btcUsd, limit(low, "buy", "59900", "0.01"));
    await exchange.placeOrder(btcUsd, limit(high, "buy", "60000", "0.01"));
    const sell = await exchange.placeOrder(btcUsd, limit(seller, "sell", "59900", "0.02"));

    expect(sell.fills).toEqual([
      { price: units("60000"), quantity: units("0.01") },
      { price: units("59900"), quantity: units("0.01") },
    ]);
    await expect(balanceOf(seller, "USD")).resolves.toEqual({
      available: units("1199"),
      reserved: 0n,
    });
    await expect(balanceOf(high, "USD")).resolves.toEqual({ available: 0n, reserved: 0n });
    await expect(balanceOf(low, "BTC")).resolves.toEqual({
      available: units("0.01"),
      reserved: 0n,
    });
  });

  it("cancels an order that would trade with its owner and releases its reservation", async () => {
    const exchange = new Exchange(db);
    const user = await funded({ BTC: "1", USD: "30000" });

    await exchange.placeOrder(btcUsd, limit(user, "sell", "60000", "0.5"));
    const buy = await exchange.placeOrder(btcUsd, limit(user, "buy", "60000", "0.5"));

    expect(buy).toEqual({ id: buy.id, status: "cancelled", filledQuantity: 0n, fills: [] });
    await expect(orderRow(buy.id)).resolves.toMatchObject({ status: "cancelled" });
    await expect(balanceOf(user, "USD")).resolves.toEqual({
      available: units("30000"),
      reserved: 0n,
    });
    await expect(balanceOf(user, "BTC")).resolves.toEqual({
      available: units("0.5"),
      reserved: units("0.5"),
    });
  });

  const marketOrder = (userId: string, side: "buy" | "sell", quantity: string) => ({
    type: "market" as const,
    userId,
    side,
    quantity: units(quantity),
  });

  it("buys at market up to the protection price, then cancels and releases the rest", async () => {
    const exchange = new Exchange(db);
    const seller = await funded({ BTC: "0.3" });
    const buyer = await funded({ USD: "20000" });
    await exchange.placeOrder(btcUsd, limit(seller, "sell", "60000", "0.1"));
    await exchange.placeOrder(btcUsd, limit(seller, "sell", "63000", "0.1"));
    const beyond = await exchange.placeOrder(btcUsd, limit(seller, "sell", "63000.01", "0.1"));

    // Best ask 60,000, so the bound is 63,000 and 0.3 × 63,000 = 18,900 is reserved.
    const buy = await exchange.placeOrder(btcUsd, marketOrder(buyer, "buy", "0.3"));

    expect(buy).toEqual({
      id: buy.id,
      status: "cancelled",
      filledQuantity: units("0.2"),
      fills: [
        { price: units("60000"), quantity: units("0.1") },
        { price: units("63000"), quantity: units("0.1") },
      ],
    });
    // Paid 6,000 + 6,300. The first fill's 300 improvement and the unfilled 0.1's 6,300 came
    // back, so nothing stays reserved.
    await expect(balanceOf(buyer, "USD")).resolves.toEqual({
      available: units("7700"),
      reserved: 0n,
    });
    await expect(orderRow(buy.id)).resolves.toMatchObject({
      status: "cancelled",
      filledQuantity: "0.200000000000000000",
    });
    await expect(orderRow(beyond.id)).resolves.toMatchObject({ status: "open" });
  });

  it("sells at market into the best bid and reports the order filled", async () => {
    const exchange = new Exchange(db);
    const buyer = await funded({ USD: "6000" });
    const seller = await funded({ BTC: "1" });
    await exchange.placeOrder(btcUsd, limit(buyer, "buy", "60000", "0.1"));

    const sell = await exchange.placeOrder(btcUsd, marketOrder(seller, "sell", "0.05"));

    expect(sell).toMatchObject({ status: "filled", filledQuantity: units("0.05") });
    await expect(orderRow(sell.id)).resolves.toMatchObject({ status: "filled" });
    await expect(balanceOf(seller, "BTC")).resolves.toEqual({
      available: units("0.95"),
      reserved: 0n,
    });
    await expect(balanceOf(seller, "USD")).resolves.toEqual({
      available: units("3000"),
      reserved: 0n,
    });
  });

  it("refuses a market buy the user cannot fund at the protection price", async () => {
    const exchange = new Exchange(db);
    const seller = await funded({ BTC: "1" });
    // Enough for 0.1 at the 60,000 ask, not for 0.1 at the 63,000 bound.
    const buyer = await funded({ USD: "6000" });
    await exchange.placeOrder(btcUsd, limit(seller, "sell", "60000", "1"));

    await expect(
      exchange.placeOrder(btcUsd, marketOrder(buyer, "buy", "0.1")),
    ).rejects.toMatchObject({ code: "insufficient_funds" });
  });

  it("refuses a market order against an empty side and reserves nothing", async () => {
    const exchange = new Exchange(db);
    const buyer = await funded({ USD: "6000" });

    await expect(
      exchange.placeOrder(btcUsd, marketOrder(buyer, "buy", "0.01")),
    ).rejects.toMatchObject({ code: "no_liquidity" });
    await expect(balanceOf(buyer, "USD")).resolves.toEqual({
      available: units("6000"),
      reserved: 0n,
    });
  });

  it("cancels a partly filled buy and releases only its unfilled quantity at its limit", async () => {
    const exchange = new Exchange(db);
    const seller = await funded({ BTC: "0.1" });
    const buyer = await funded({ USD: "30000" });
    const buy = await exchange.placeOrder(btcUsd, limit(buyer, "buy", "60000", "0.5"));
    await exchange.placeOrder(btcUsd, limit(seller, "sell", "60000", "0.1"));

    await expect(exchange.cancelOrder(btcUsd, buy.id)).resolves.toBe("cancelled");

    // 0.1 filled for 6,000; the other 0.4 × 60,000 = 24,000 comes back.
    await expect(balanceOf(buyer, "USD")).resolves.toEqual({
      available: units("24000"),
      reserved: 0n,
    });
    await expect(orderRow(buy.id)).resolves.toMatchObject({
      status: "cancelled",
      filledQuantity: "0.100000000000000000",
    });
  });

  it("reports an order that is no longer on the book as not open and changes nothing", async () => {
    const exchange = new Exchange(db);
    const seller = await funded({ BTC: "0.1" });
    const buyer = await funded({ USD: "6000" });
    const sell = await exchange.placeOrder(btcUsd, limit(seller, "sell", "60000", "0.1"));
    await exchange.placeOrder(btcUsd, limit(buyer, "buy", "60000", "0.1"));

    await expect(exchange.cancelOrder(btcUsd, sell.id)).resolves.toBe("not_open");
    await expect(orderRow(sell.id)).resolves.toMatchObject({ status: "filled" });
    await expect(balanceOf(seller, "USD")).resolves.toEqual({
      available: units("6000"),
      reserved: 0n,
    });
  });

  // Holds a row lock on the user's USD available account from another connection, so an
  // order of theirs is admitted and then waits inside its reservation until `release`.
  async function blockReservations(userId: string) {
    const client = await pool.connect();
    await client.query("begin");
    await client.query("select id from ledger_accounts where id = $1 for update", [
      await openAccount(db, userId, "USD", "available"),
    ]);
    return async () => {
      await client.query("commit");
      client.release();
    };
  }

  it("refuses commands past the cap before reserving, in that market only", async () => {
    const exchange = new Exchange(db, { maxPendingCommands: 1 });
    const first = await funded({ USD: "6000" });
    const second = await funded({ USD: "6000" });
    const release = await blockReservations(first);

    let waiting;
    try {
      waiting = exchange.placeOrder(btcUsd, limit(first, "buy", "60000", "0.1"));

      await expect(
        exchange.placeOrder(btcUsd, limit(second, "buy", "60000", "0.1")),
      ).rejects.toBeInstanceOf(MarketBusyError);
      await expect(exchange.cancelOrder(btcUsd, randomUUID())).rejects.toBeInstanceOf(
        MarketBusyError,
      );
      await expect(balanceOf(second, "USD")).resolves.toEqual({
        available: units("6000"),
        reserved: 0n,
      });
      await expect(
        exchange.placeOrder(ethUsd, limit(second, "buy", "3000", "0.01")),
      ).resolves.toMatchObject({ status: "open" });
    } finally {
      await release();
    }

    await expect(waiting).resolves.toMatchObject({ status: "open" });
    // The slot is free again. 5,970 left after the ETH order's 30.
    await expect(
      exchange.placeOrder(btcUsd, limit(second, "buy", "59000", "0.1")),
    ).resolves.toMatchObject({ status: "open" });
  });

  it("frees a slot when a command is refused for funds", async () => {
    const exchange = new Exchange(db, { maxPendingCommands: 1 });
    const user = await funded({ USD: "100" });

    await expect(
      exchange.placeOrder(btcUsd, limit(user, "buy", "60000", "0.1")),
    ).rejects.toMatchObject({ code: "insufficient_funds" });
    await expect(
      exchange.placeOrder(btcUsd, limit(user, "buy", "1000", "0.1")),
    ).resolves.toMatchObject({ status: "open" });
  });

  // Each round, one taker sweeps both buyers' bids in BTC-USD while another sweeps them in
  // ETH-USD in the opposite order, so the two settlements debit the same two USD reserved
  // accounts in opposite fill order at the same time.
  it("settles two markets in parallel that debit the same accounts without deadlocking", async () => {
    const exchange = new Exchange(db);
    const first = await funded({ USD: "100000" });
    const second = await funded({ USD: "100000" });
    const btcSeller = await funded({ BTC: "1" });
    const ethSeller = await funded({ ETH: "1" });

    for (let round = 0; round < 15; round++) {
      await Promise.all([
        exchange.placeOrder(btcUsd, limit(first, "buy", "60010", "0.01")),
        exchange.placeOrder(btcUsd, limit(second, "buy", "60000", "0.01")),
        exchange.placeOrder(ethUsd, limit(second, "buy", "3010", "0.01")),
        exchange.placeOrder(ethUsd, limit(first, "buy", "3000", "0.01")),
      ]);
      const [btc, eth] = await Promise.all([
        exchange.placeOrder(btcUsd, limit(btcSeller, "sell", "60000", "0.02")),
        exchange.placeOrder(ethUsd, limit(ethSeller, "sell", "3000", "0.02")),
      ]);
      expect([btc.status, eth.status]).toEqual(["filled", "filled"]);
    }

    await expect(balanceOf(first, "USD")).resolves.toMatchObject({ reserved: 0n });
    await expect(balanceOf(second, "USD")).resolves.toMatchObject({ reserved: 0n });
  });

  it("leaves every asset's ledger summing to zero", async () => {
    const totals = await db.execute<{ asset: string; total: string }>(sql`
      select a.asset, sum(e.amount)::text as total
      from ledger_entries e join ledger_accounts a on a.id = e.account_id
      group by a.asset`);

    for (const row of totals.rows) {
      expect({ asset: row.asset, total: Number(row.total) }).toEqual({
        asset: row.asset,
        total: 0,
      });
    }
  });
});
