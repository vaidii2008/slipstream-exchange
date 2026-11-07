import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { addTrade, type Candle, type CandleTrade, candleStart, loadCandles } from "./candles.ts";
import { Exchange } from "./exchange.ts";
import { deposit } from "./ledger.ts";
import { parseAmount } from "./money.ts";
import type { Market } from "./orders.ts";
import { trades, users } from "./schema.ts";
import { useTestServer } from "./testing.ts";

const { db, uniqueEmail, testMarket } = useTestServer();

const units = (value: string): bigint => {
  const parsed = parseAmount(value, 8);
  if (!parsed.ok) {
    throw new Error(`bad test amount ${value}: ${parsed.reason}`);
  }
  return parsed.units;
};

const trade = (price: string, quantity: string, time: string): CandleTrade => ({
  price: units(price),
  quantity: units(quantity),
  time: new Date(time),
});

const fold = (list: CandleTrade[]): Candle[] => {
  const candles: Candle[] = [];
  for (const next of list) {
    const last = candles.at(-1);
    const candle = addTrade(last, next);
    if (candle.start.getTime() === last?.start.getTime()) {
      candles[candles.length - 1] = candle;
    } else {
      candles.push(candle);
    }
  }
  return candles;
};

describe("candleStart", () => {
  it("rounds down to the minute in UTC", () => {
    expect(candleStart(new Date("2026-11-06T14:07:59.999Z"))).toEqual(
      new Date("2026-11-06T14:07:00.000Z"),
    );
    expect(candleStart(new Date("2026-11-06T14:08:00.000Z"))).toEqual(
      new Date("2026-11-06T14:08:00.000Z"),
    );
  });
});

describe("addTrade", () => {
  it("opens a candle at the first trade's price and quantity", () => {
    expect(addTrade(undefined, trade("60000", "0.1", "2026-11-06T14:07:12Z"))).toEqual({
      start: new Date("2026-11-06T14:07:00Z"),
      open: units("60000"),
      high: units("60000"),
      low: units("60000"),
      close: units("60000"),
      volume: units("0.1"),
      trades: 1,
    });
  });

  it("widens high and low, moves close and adds volume within the minute", () => {
    const candles = fold([
      trade("60000", "0.1", "2026-11-06T14:07:01Z"),
      trade("60500", "0.2", "2026-11-06T14:07:20Z"),
      trade("59500", "0.3", "2026-11-06T14:07:40Z"),
      trade("60100", "0.4", "2026-11-06T14:07:59.999Z"),
    ]);

    expect(candles).toEqual([
      {
        start: new Date("2026-11-06T14:07:00Z"),
        open: units("60000"),
        high: units("60500"),
        low: units("59500"),
        close: units("60100"),
        volume: units("1"),
        trades: 4,
      },
    ]);
  });

  it("starts a new candle at the minute boundary instead of changing the last one", () => {
    const last = addTrade(undefined, trade("60000", "0.1", "2026-11-06T14:07:59.999Z"));
    const next = addTrade(last, trade("61000", "0.2", "2026-11-06T14:08:00Z"));

    expect(next).toEqual({
      start: new Date("2026-11-06T14:08:00Z"),
      open: units("61000"),
      high: units("61000"),
      low: units("61000"),
      close: units("61000"),
      volume: units("0.2"),
      trades: 1,
    });
    expect(last.close).toBe(units("60000"));
  });
});

describe("loadCandles", () => {
  let btcUsd: Market;

  // Each test's exchange gets a market of its own.
  beforeEach(async () => {
    btcUsd = await testMarket("BTC-USD");
  });

  async function funded(asset: string, amount: string): Promise<string> {
    const [user] = await db
      .insert(users)
      .values({ email: uniqueEmail("candles-test"), passwordHash: "not-a-real-hash" })
      .returning({ id: users.id });
    if (user === undefined) {
      throw new Error("user insert returned no row");
    }
    await deposit(db, user.id, asset, units(amount));
    return user.id;
  }

  it("groups trades by minute with the same result as folding them one by one", async () => {
    const exchange = new Exchange(db);
    const seller = await funded("BTC", "1");
    const buyer = await funded("USD", "100000");
    const order = (userId: string, side: "buy" | "sell", price: string, quantity: string) =>
      exchange.placeOrder(btcUsd, {
        type: "limit",
        userId,
        side,
        price: units(price),
        quantity: units(quantity),
      });

    // Four fills at three prices, each a resting sell lifted by a buy.
    const fills: [price: string, quantity: string][] = [
      ["60000", "0.1"],
      ["60500", "0.2"],
      ["59500", "0.3"],
      ["61000", "0.4"],
    ];
    const takerIds: string[] = [];
    for (const [price, quantity] of fills) {
      await order(seller, "sell", price, quantity);
      takerIds.push((await order(buyer, "buy", price, quantity)).id);
    }

    // Moved to minutes in 2001, where no other test trades, so only these four are counted.
    // The first three share 00:01; the last is alone in 00:03, with nothing in 00:02.
    const times = [
      "2001-01-01T00:01:05Z",
      "2001-01-01T00:01:30Z",
      "2001-01-01T00:01:59.999Z",
      "2001-01-01T00:03:00Z",
    ];
    for (const [index, takerId] of takerIds.entries()) {
      await db
        .update(trades)
        .set({ createdAt: new Date(times[index]!) })
        .where(eq(trades.takerOrderId, takerId));
    }

    const loaded = await loadCandles(db, btcUsd, {
      limit: 10,
      before: new Date("2001-01-01T00:04:00Z"),
    });

    expect(loaded).toEqual(
      fold(fills.map(([price, quantity], i) => trade(price, quantity, times[i]!))),
    );
    expect(loaded).toEqual([
      {
        start: new Date("2001-01-01T00:01:00Z"),
        open: units("60000"),
        high: units("60500"),
        low: units("59500"),
        close: units("59500"),
        volume: units("0.6"),
        trades: 3,
      },
      {
        start: new Date("2001-01-01T00:03:00Z"),
        open: units("61000"),
        high: units("61000"),
        low: units("61000"),
        close: units("61000"),
        volume: units("0.4"),
        trades: 1,
      },
    ]);

    // The window is the `limit` minutes before the one `before` falls in. Empty minutes
    // count towards it and return no candle.
    await expect(
      loadCandles(db, btcUsd, { limit: 1, before: new Date("2001-01-01T00:04:00Z") }),
    ).resolves.toEqual([loaded[1]]);
    await expect(
      loadCandles(db, btcUsd, { limit: 1, before: new Date("2001-01-01T00:03:30Z") }),
    ).resolves.toEqual([]);
    await expect(
      loadCandles(db, btcUsd, { limit: 2, before: new Date("2001-01-01T00:03:30Z") }),
    ).resolves.toEqual([loaded[0]]);
    await expect(
      loadCandles(db, btcUsd, { limit: 2, before: new Date("2001-01-01T00:04:00Z") }),
    ).resolves.toEqual([loaded[1]]);
  });

  it("without before, reads up to the current minute and no further back than limit", async () => {
    const exchange = new Exchange(db);
    const seller = await funded("BTC", "1");
    const buyer = await funded("USD", "100000");
    const lift = async (price: string) => {
      await exchange.placeOrder(btcUsd, {
        type: "limit",
        userId: seller,
        side: "sell",
        price: units(price),
        quantity: units("0.1"),
      });
      return exchange.placeOrder(btcUsd, {
        type: "limit",
        userId: buyer,
        side: "buy",
        price: units(price),
        quantity: units("0.1"),
      });
    };

    // One trade now, in the current minute, and one in the minute just outside a 3-minute
    // window that ends with the current minute. If the clock passes a minute boundary before
    // the read, the window moves forward and both still hold.
    const recent = await lift("62000");
    const old = await lift("63000");
    const now = new Date();
    const current = candleStart(now);
    await db.update(trades).set({ createdAt: now }).where(eq(trades.takerOrderId, recent.id));
    await db
      .update(trades)
      .set({ createdAt: new Date(current.getTime() - 3 * 60_000) })
      .where(eq(trades.takerOrderId, old.id));

    const loaded = await loadCandles(db, btcUsd, { limit: 3 });

    // Other tests may trade in the same minute, so only this test's bounds are asserted.
    expect(loaded.at(-1)?.start).toEqual(current);
    expect(loaded.every((candle) => candle.start.getTime() > current.getTime() - 3 * 60_000)).toBe(
      true,
    );
  });
});
