// Public market data: anyone can read it, no token needed. The rule for everything here is
// that it never names a user or an order. The engine's own snapshots and events carry userId
// and order ids, so every response is built field by field rather than passed through.

import { desc, eq } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { invalidRequest } from "./auth.ts";
import type { DepthLevel } from "./book.ts";
import { formatCandle, loadCandles } from "./candles.ts";
import type { Exchange } from "./exchange.ts";
import type { Database } from "./ledger.ts";
import { formatAmount, fromNumeric } from "./money.ts";
import { loadMarket, loadMarkets, type Market } from "./orders.ts";
import { orders, trades } from "./schema.ts";

export type MarketDataDependencies = {
  db: Database;
  exchange: Exchange;
};

const bookQuery = z.strictObject({
  depth: z.coerce.number().int().min(1).max(200).default(50),
});
const tradesQuery = z.strictObject({
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

// 1,440 is one day of one-minute candles.
const candlesQuery = z.strictObject({
  limit: z.coerce.number().int().min(1).max(1440).default(500),
  // Paging back: the start of the oldest minute the client already asked for.
  before: z.iso
    .datetime({ offset: true })
    .transform((value) => new Date(value))
    .optional(),
});

const takerOrders = alias(orders, "taker");

// Newest first. The taker's side is public on every exchange: it says whether the trade was
// a buy lifting an ask or a sell hitting a bid, not who made it.
async function recentTrades(db: Database, market: Market, limit: number) {
  const rows = await db
    .select({
      id: trades.id,
      sequence: trades.engineSequence,
      price: trades.price,
      quantity: trades.quantity,
      takerSide: takerOrders.side,
      createdAt: trades.createdAt,
    })
    .from(trades)
    .innerJoin(takerOrders, eq(takerOrders.id, trades.takerOrderId))
    .where(eq(trades.market, market.symbol))
    .orderBy(desc(trades.id))
    .limit(limit);
  return rows.map((row) => ({
    id: row.id,
    // The same number the trades channel carries, so a client joining the two can drop the
    // trades it receives from both.
    sequence: row.sequence,
    price: formatAmount(fromNumeric(row.price, market.quoteScale), market.quoteScale),
    quantity: formatAmount(fromNumeric(row.quantity, market.baseScale), market.baseScale),
    takerSide: row.takerSide,
    createdAt: row.createdAt.toISOString(),
  }));
}

export function registerMarketDataRoutes(
  app: FastifyInstance,
  { db, exchange }: MarketDataDependencies,
) {
  // A path parameter is always a string; one that names no market is a 404.
  type ByMarket = { Params: { symbol: string } };

  // What a client needs to build a valid order and show amounts at the market's precision.
  app.get("/markets", async (_request, reply) => {
    const listed = [...(await loadMarkets(db)).values()];
    listed.sort((a, b) => a.symbol.localeCompare(b.symbol));
    return reply.code(200).send({
      markets: listed.map((market) => ({
        symbol: market.symbol,
        baseAsset: market.baseAsset,
        quoteAsset: market.quoteAsset,
        tickSize: formatAmount(market.tickSize, market.quoteScale),
        quantityStep: formatAmount(market.quantityStep, market.baseScale),
        minQuantity: formatAmount(market.minQuantity, market.baseScale),
      })),
    });
  });

  app.get<ByMarket>("/markets/:symbol/book", async (request, reply) => {
    const market = await loadMarket(db, request.params.symbol);
    if (market === undefined) {
      return reply.code(404).send({ error: "not_found" });
    }
    const query = bookQuery.safeParse(request.query);
    if (!query.success) {
      return reply.code(400).send(invalidRequest(query.error));
    }

    const { sequence, bids, asks } = exchange.depth(market.symbol, query.data.depth);
    const level = ({ price, quantity }: DepthLevel) => ({
      price: formatAmount(price, market.quoteScale),
      quantity: formatAmount(quantity, market.baseScale),
    });
    return reply.code(200).send({
      market: market.symbol,
      sequence,
      bids: bids.map(level),
      asks: asks.map(level),
    });
  });

  app.get<ByMarket>("/markets/:symbol/trades", async (request, reply) => {
    const market = await loadMarket(db, request.params.symbol);
    if (market === undefined) {
      return reply.code(404).send({ error: "not_found" });
    }
    const query = tradesQuery.safeParse(request.query);
    if (!query.success) {
      return reply.code(400).send(invalidRequest(query.error));
    }

    return reply.code(200).send({
      market: market.symbol,
      trades: await recentTrades(db, market, query.data.limit),
    });
  });

  // Oldest first, one per minute that had a trade; a minute with none has no candle.
  app.get<ByMarket>("/markets/:symbol/candles", async (request, reply) => {
    const market = await loadMarket(db, request.params.symbol);
    if (market === undefined) {
      return reply.code(404).send({ error: "not_found" });
    }
    const query = candlesQuery.safeParse(request.query);
    if (!query.success) {
      return reply.code(400).send(invalidRequest(query.error));
    }

    const candles = await loadCandles(db, market, query.data);
    return reply.code(200).send({
      market: market.symbol,
      interval: "1m",
      candles: candles.map((candle) => formatCandle(market, candle)),
    });
  });
}
