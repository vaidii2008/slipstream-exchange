import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { balancesOf, deposit } from "./ledger.ts";
import { parseAmount } from "./money.ts";
import {
  DuplicateOrderError,
  loadMarket,
  type Market,
  OrderError,
  protectionPrice,
  recordOrder,
} from "./orders.ts";
import { orders, users } from "./schema.ts";
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
      protectionPrice: orders.protectionPrice,
      quantity: orders.quantity,
      filledQuantity: orders.filledQuantity,
      status: orders.status,
    })
    .from(orders)
    .where(eq(orders.userId, userId));
}

let btcUsd: Market;

beforeAll(async () => {
  const market = await loadMarket(db, "BTC-USD");
  if (market === undefined) {
    throw new Error("BTC-USD is not seeded");
  }
  btcUsd = market;
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

describe("protectionPrice", () => {
  it("moves the best opposite price 5% against the taker", () => {
    expect(protectionPrice(btcUsd, "buy", units("60000"))).toBe(units("63000"));
    expect(protectionPrice(btcUsd, "sell", units("60000"))).toBe(units("57000"));
  });

  it("rounds the band down onto the tick grid, so the bound never passes 5%", () => {
    // 5% of 100.07 is 5.0035: 5.00 on a 0.01 tick.
    expect(protectionPrice(btcUsd, "buy", units("100.07"))).toBe(units("105.07"));
    expect(protectionPrice(btcUsd, "sell", units("100.07"))).toBe(units("95.07"));
  });

  it("rejects a market order with nothing on the other side", () => {
    expect(() => protectionPrice(btcUsd, "buy", undefined)).toThrow(
      expect.objectContaining({ code: "no_liquidity" }),
    );
  });
});

describe("recordOrder", () => {
  it("reserves price × quantity of USD for a buy and records it pending", async () => {
    const userId = await createUser();
    await deposit(db, userId, "USD", units("1000"));

    const order = await recordOrder(db, btcUsd, {
      type: "limit",
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
        protectionPrice: null,
        quantity: "0.250000000000000000",
        filledQuantity: "0.000000000000000000",
        status: "pending",
      },
    ]);
  });

  it("reserves the quantity of BTC for a sell", async () => {
    const userId = await createUser();
    await deposit(db, userId, "BTC", units("1"));

    await recordOrder(db, btcUsd, {
      type: "limit",
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
      recordOrder(db, btcUsd, {
        type: "limit",
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

  it("reserves quantity × protection price for a market buy and records that price", async () => {
    const userId = await createUser();
    await deposit(db, userId, "USD", units("10000"));

    await recordOrder(db, btcUsd, {
      type: "market",
      userId,
      side: "buy",
      quantity: units("0.1"),
      protectionPrice: units("63000"),
    });

    await expect(balanceOf(userId, "USD")).resolves.toEqual({
      available: units("3700"),
      reserved: units("6300"),
    });
    await expect(ordersOf(userId)).resolves.toEqual([
      expect.objectContaining({
        type: "market",
        price: null,
        protectionPrice: "63000.000000000000000000",
        status: "pending",
      }),
    ]);
  });

  it("rejects an order the user cannot fund and records nothing", async () => {
    const userId = await createUser();
    await deposit(db, userId, "USD", units("100"));

    await expectOrderError(
      recordOrder(db, btcUsd, {
        type: "limit",
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
        recordOrder(db, btcUsd, {
          type: "limit",
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

  it("reserves for only one of several parallel orders with the same client order id", async () => {
    const userId = await createUser();
    // Enough for one order, so a repeat that reserved before noticing would fail for funds.
    await deposit(db, userId, "BTC", units("0.25"));

    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () =>
        recordOrder(db, btcUsd, {
          type: "limit",
          userId,
          side: "sell",
          price: units("50000"),
          quantity: units("0.25"),
          clientOrderId: "same-key",
        }),
      ),
    );

    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason as unknown] : [],
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(5);
    for (const reason of rejected) {
      expect(reason).toBeInstanceOf(DuplicateOrderError);
      expect(reason).toMatchObject({ orderId: fulfilled[0]?.value.id });
    }
    await expect(ordersOf(userId)).resolves.toHaveLength(1);
    await expect(balanceOf(userId, "BTC")).resolves.toEqual({
      available: 0n,
      reserved: units("0.25"),
    });
  });
});
