import { eq, sql } from "drizzle-orm";
import { setTimeout as delay } from "node:timers/promises";
import { beforeAll, describe, expect, it } from "vitest";
import { balancesOf, deposit } from "./ledger.ts";
import { parseAmount } from "./money.ts";
import {
  Exchange,
  loadMarket,
  type Market,
  OrderError,
  recordLimitOrder,
  SerialQueue,
} from "./orders.ts";
import { orders, trades, users } from "./schema.ts";
import { useTestServer } from "./testing.ts";

const { db, uniqueEmail } = useTestServer();

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
    .values({ email: uniqueEmail("orders-test"), passwordHash: "not-a-real-hash" })
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

async function ordersOf(userId: string) {
  return db
    .select({
      market: orders.market,
      side: orders.side,
      type: orders.type,
      price: orders.price,
      quantity: orders.quantity,
      filledQuantity: orders.filledQuantity,
      status: orders.status,
    })
    .from(orders)
    .where(eq(orders.userId, userId));
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

async function expectOrderError(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(OrderError);
  await expect(promise).rejects.toMatchObject({ code });
}

describe("loadMarket", () => {
  it("converts the market's grid to minor units", () => {
    expect(btcUsd).toEqual({
      symbol: "BTC-USD",
      baseAsset: "BTC",
      quoteAsset: "USD",
      baseScale: 8,
      quoteScale: 8,
      tickSize: units("0.01"),
      quantityStep: units("0.0001"),
      minQuantity: units("0.0001"),
    });
  });

  it("returns undefined for a market that is not listed", async () => {
    await expect(loadMarket(db, "DOGE-USD")).resolves.toBeUndefined();
  });
});

describe("recordLimitOrder", () => {
  it("reserves price × quantity of USD for a buy and records it pending", async () => {
    const userId = await createUser();
    await deposit(db, userId, "USD", units("1000"));

    const order = await recordLimitOrder(db, btcUsd, {
      userId,
      side: "buy",
      price: units("2000.50"),
      quantity: units("0.25"),
    });

    expect(order.id).toMatch(/^[0-9a-f-]{36}$/);
    // 0.25 × 2,000.50 = 500.125
    await expect(balanceOf(userId, "USD")).resolves.toEqual({
      available: units("499.875"),
      reserved: units("500.125"),
    });
    await expect(ordersOf(userId)).resolves.toEqual([
      {
        market: "BTC-USD",
        side: "buy",
        type: "limit",
        price: "2000.500000000000000000",
        quantity: "0.250000000000000000",
        filledQuantity: "0.000000000000000000",
        status: "pending",
      },
    ]);
  });

  it("reserves the quantity of BTC for a sell", async () => {
    const userId = await createUser();
    await deposit(db, userId, "BTC", units("1"));

    await recordLimitOrder(db, btcUsd, {
      userId,
      side: "sell",
      price: units("60000"),
      quantity: units("0.4"),
    });

    await expect(balanceOf(userId, "BTC")).resolves.toEqual({
      available: units("0.6"),
      reserved: units("0.4"),
    });
  });

  it.each([
    ["price_not_positive", "0", "0.01"],
    ["price_off_tick", "100.005", "0.01"],
    ["quantity_below_minimum", "100", "0.00005"],
    ["quantity_off_step", "100", "0.00015"],
  ])("rejects %s and reserves nothing", async (code, price, quantity) => {
    const userId = await createUser();
    await deposit(db, userId, "USD", units("1000"));

    await expectOrderError(
      recordLimitOrder(db, btcUsd, {
        userId,
        side: "buy",
        price: units(price),
        quantity: units(quantity),
      }),
      code,
    );

    await expect(balanceOf(userId, "USD")).resolves.toEqual({
      available: units("1000"),
      reserved: 0n,
    });
    await expect(ordersOf(userId)).resolves.toEqual([]);
  });

  it("rejects an order the user cannot fund and records nothing", async () => {
    const userId = await createUser();
    await deposit(db, userId, "USD", units("100"));

    await expectOrderError(
      recordLimitOrder(db, btcUsd, {
        userId,
        side: "buy",
        price: units("100.01"),
        quantity: units("1"),
      }),
      "insufficient_funds",
    );

    await expect(balanceOf(userId, "USD")).resolves.toEqual({
      available: units("100"),
      reserved: 0n,
    });
    await expect(ordersOf(userId)).resolves.toEqual([]);
  });

  it("lets exactly as many parallel orders through as the balance funds", async () => {
    const userId = await createUser();
    await deposit(db, userId, "BTC", units("1"));

    const results = await Promise.allSettled(
      Array.from({ length: 12 }, () =>
        recordLimitOrder(db, btcUsd, {
          userId,
          side: "sell",
          price: units("50000"),
          quantity: units("0.25"),
        }),
      ),
    );

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(4);
    await expect(ordersOf(userId)).resolves.toHaveLength(4);
    await expect(balanceOf(userId, "BTC")).resolves.toEqual({
      available: 0n,
      reserved: units("1"),
    });
  });
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

describe("Exchange.placeLimitOrder", () => {
  // A fresh exchange per test, so every test starts from empty books.
  async function funded(holdings: Record<string, string>): Promise<string> {
    const userId = await createUser();
    for (const [asset, amount] of Object.entries(holdings)) {
      await deposit(db, userId, asset, units(amount));
    }
    return userId;
  }

  const limit = (userId: string, side: "buy" | "sell", price: string, quantity: string) => ({
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

    const placed = await exchange.placeLimitOrder(btcUsd, limit(buyer, "buy", "60000", "0.5"));

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

    const sell = await exchange.placeLimitOrder(btcUsd, limit(seller, "sell", "60000", "0.5"));
    const buy = await exchange.placeLimitOrder(btcUsd, limit(buyer, "buy", "60100", "0.5"));

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

    const sell = await exchange.placeLimitOrder(btcUsd, limit(seller, "sell", "60000", "0.2"));
    const buy = await exchange.placeLimitOrder(btcUsd, limit(buyer, "buy", "60000", "0.5"));

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

    await exchange.placeLimitOrder(btcUsd, limit(low, "buy", "59900", "0.01"));
    await exchange.placeLimitOrder(btcUsd, limit(high, "buy", "60000", "0.01"));
    const sell = await exchange.placeLimitOrder(btcUsd, limit(seller, "sell", "59900", "0.02"));

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

    await exchange.placeLimitOrder(btcUsd, limit(user, "sell", "60000", "0.5"));
    const buy = await exchange.placeLimitOrder(btcUsd, limit(user, "buy", "60000", "0.5"));

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
        exchange.placeLimitOrder(btcUsd, limit(first, "buy", "60010", "0.01")),
        exchange.placeLimitOrder(btcUsd, limit(second, "buy", "60000", "0.01")),
        exchange.placeLimitOrder(ethUsd, limit(second, "buy", "3010", "0.01")),
        exchange.placeLimitOrder(ethUsd, limit(first, "buy", "3000", "0.01")),
      ]);
      const [btc, eth] = await Promise.all([
        exchange.placeLimitOrder(btcUsd, limit(btcSeller, "sell", "60000", "0.02")),
        exchange.placeLimitOrder(ethUsd, limit(ethSeller, "sell", "3000", "0.02")),
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
