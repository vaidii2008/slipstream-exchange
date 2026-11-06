// One-minute OHLCV candles: open, high, low and close price, and the base quantity traded,
// for each minute that had a trade. Derived from the trades table and never stored, so there
// is no second copy of a trade to keep in step. History is one GROUP BY over trades; the bar
// in progress is kept live by folding each new trade into it with addTrade. Both bucket by
// the trade's recorded time, which is the time the feed reports (see settle).

import { and, count, desc, eq, lt, max, min, sql, sum } from "drizzle-orm";
import type { Database } from "./ledger.ts";
import { fromNumeric } from "./money.ts";
import type { Market } from "./orders.ts";
import { trades } from "./schema.ts";

export const CANDLE_MS = 60_000;

export type Candle = {
  // The first instant of the candle's minute, in UTC.
  start: Date;
  open: bigint;
  high: bigint;
  low: bigint;
  close: bigint;
  volume: bigint;
  // A candle only ever gains trades, so of two copies of the same minute the one with more
  // trades is the newer. Engine sequences cannot say that: they restart at 1 on boot.
  trades: number;
};

export type CandleTrade = { price: bigint; quantity: bigint; time: Date };

export function candleStart(time: Date): Date {
  return new Date(Math.floor(time.getTime() / CANDLE_MS) * CANDLE_MS);
}

// The candle after one more trade. A trade in a different minute starts a new candle; the
// caller keeps the finished one if it wants it.
export function addTrade(candle: Candle | undefined, trade: CandleTrade): Candle {
  const start = candleStart(trade.time);
  const { price, quantity } = trade;
  if (candle === undefined || candle.start.getTime() !== start.getTime()) {
    return {
      start,
      open: price,
      high: price,
      low: price,
      close: price,
      volume: quantity,
      trades: 1,
    };
  }
  return {
    start,
    open: candle.open,
    high: price > candle.high ? price : candle.high,
    low: price < candle.low ? price : candle.low,
    close: price,
    volume: candle.volume + quantity,
    trades: candle.trades + 1,
  };
}

// The latest `limit` candles from minutes before the one `before` falls in (from every
// minute if it is undefined), oldest first. A client pages back by passing the start of the
// oldest candle it has. Trade ids follow settlement order, so they decide open and close.
export async function loadCandles(
  db: Database,
  market: Market,
  { limit, before }: { limit: number; before?: Date | undefined },
): Promise<Candle[]> {
  // date_bin, not date_trunc: date_trunc on a timestamptz cuts in the session's time zone.
  const start = sql`date_bin('1 minute', ${trades.createdAt}, timestamptz '2000-01-01 00:00Z')`;
  const rows = await db
    .select({
      start: start.mapWith(trades.createdAt),
      open: sql`(array_agg(${trades.price} order by ${trades.id}))[1]`.mapWith(String),
      high: max(trades.price),
      low: min(trades.price),
      close: sql`(array_agg(${trades.price} order by ${trades.id} desc))[1]`.mapWith(String),
      volume: sum(trades.quantity),
      trades: count(),
    })
    .from(trades)
    .where(
      and(
        eq(trades.market, market.symbol),
        before === undefined ? undefined : lt(trades.createdAt, candleStart(before)),
      ),
    )
    .groupBy(start)
    .orderBy(desc(start))
    .limit(limit);

  return rows.reverse().map((row) => {
    // A group always has at least one trade, so no aggregate is null.
    const price = (value: string | null) => fromNumeric(value ?? "0", market.quoteScale);
    return {
      start: row.start,
      open: price(row.open),
      high: price(row.high),
      low: price(row.low),
      close: price(row.close),
      volume: fromNumeric(row.volume ?? "0", market.baseScale),
      trades: row.trades,
    };
  });
}
