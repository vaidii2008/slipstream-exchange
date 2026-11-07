// The order API. It needs both orders.ts (markets, rejections) and exchange.ts (placing), and
// exchange.ts already imports orders.ts, so the routes live here rather than in either.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { authenticatedUserId, bearerAuth, invalidRequest } from "./auth.ts";
import type { Side } from "./book.ts";
import { type Exchange, MarketBusyError, MarketHaltedError } from "./exchange.ts";
import type { Database } from "./ledger.ts";
import { type Metrics, NO_MARKET, type OrderOutcome } from "./metrics.ts";
import { formatAmount, fromNumeric, parseAmount } from "./money.ts";
import { findOrder, listFills, listOrders, type OrderRow, takerFills } from "./history.ts";
import {
  DuplicateOrderError,
  loadMarket,
  loadMarkets,
  type Market,
  OrderError,
  type OrderErrorCode,
} from "./orders.ts";
import { hitFixedWindow, type RateLimit } from "./ratelimit.ts";
import type { RedisClient } from "./redis.ts";
import type { AccessTokens } from "./tokens.ts";
import { AMOUNT_MESSAGES, fieldError } from "./wallet.ts";

export type TradingDependencies = {
  db: Database;
  tokens: AccessTokens;
  exchange: Exchange;
  redis: RedisClient;
  orderRateLimit: RateLimit;
  metrics: Metrics;
};

// Prices and quantities travel as strings, like deposit amounts. A market order has no price,
// and sending one is rejected rather than ignored: the client may think it set a limit.
const orderFields = {
  market: z.string().min(1).max(32),
  side: z.enum(["buy", "sell"]),
  quantity: z.string().max(64),
  // The idempotency key. Printable and short, since it is stored and echoed back.
  clientOrderId: z
    .string()
    .regex(/^[A-Za-z0-9._:-]{1,64}$/, "must be 1 to 64 letters, digits or . _ : -")
    .optional(),
};
const orderBody = z.discriminatedUnion("type", [
  z.strictObject({ ...orderFields, type: z.literal("limit"), price: z.string().max(64) }),
  z.strictObject({ ...orderFields, type: z.literal("market") }),
]);

// Which field each grid rejection is about, and what to tell the client.
const GRID_ERRORS: Record<
  Exclude<OrderErrorCode, "insufficient_funds" | "no_liquidity">,
  [string, string]
> = {
  price_not_positive: ["price", "must be positive"],
  price_off_tick: ["price", "must be a multiple of the market's tick size"],
  quantity_below_minimum: ["quantity", "is below the market's minimum quantity"],
  quantity_off_step: ["quantity", "must be a multiple of the market's quantity step"],
};

const orderParams = z.object({ id: z.uuid() });

// Lists are bounded so one request cannot pull a bot's entire history.
const listing = {
  market: z.string().min(1).max(32).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
};
const ordersQuery = z.strictObject({
  ...listing,
  status: z.enum(["open", "closed", "all"]).default("all"),
});
const fillsQuery = z.strictObject(listing);

// Postgres pads NUMERIC to 18 decimals; clients see the asset's own scale, as on placement.
const rescale = (value: string, scale: number) => formatAmount(fromNumeric(value, scale), scale);

function orderJson(row: OrderRow, market: Market) {
  return {
    id: row.id,
    market: row.market,
    side: row.side,
    type: row.type,
    price: row.price === null ? null : rescale(row.price, market.quoteScale),
    quantity: rescale(row.quantity, market.baseScale),
    filledQuantity: rescale(row.filledQuantity, market.baseScale),
    status: row.status,
    clientOrderId: row.clientOrderId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// The two ways a market refuses a command it never started, both 503. Halted lasts until a
// restart; busy clears as the queue drains, so it says to retry shortly.
function unavailable(reply: FastifyReply, error: MarketHaltedError | MarketBusyError) {
  if (error instanceof MarketBusyError) {
    return reply
      .code(503)
      .header("retry-after", 1)
      .send({
        error: "market_busy",
        message: `${error.market} has too many orders waiting, retry shortly`,
      });
  }
  return reply.code(503).send({
    error: "market_halted",
    message: `${error.market} is halted and accepts no orders or cancels until it restarts`,
  });
}

function marketOf(markets: Map<string, Market>, symbol: string): Market {
  const market = markets.get(symbol);
  if (market === undefined) {
    throw new Error(`a row refers to market ${symbol}, which is not listed`);
  }
  return market;
}

export function registerTradingRoutes(
  app: FastifyInstance,
  { db, tokens, exchange, redis, orderRateLimit, metrics }: TradingDependencies,
) {
  const authenticate = bearerAuth(tokens);

  // Fails open: if Redis is unreachable the order goes ahead and the failure is logged. The
  // limiter is a brake on runaway clients, not part of what makes an order correct, and the
  // per-market queue cap still bounds the load.
  async function underOrderLimit(request: FastifyRequest, reply: FastifyReply, userId: string) {
    let verdict;
    try {
      verdict = await hitFixedWindow(redis, `ratelimit:orders:${userId}`, orderRateLimit);
    } catch (error) {
      request.log.error({ err: error }, "order rate limit unavailable, allowing the order");
      return true;
    }
    if (verdict.allowed) {
      return true;
    }
    void reply
      .code(429)
      .header("retry-after", Math.ceil(verdict.retryAfterMs / 1000))
      .send({ error: "rate_limited", message: "too many orders, slow down" });
    return false;
  }

  // A repeated client order id. The same order again gets the original back, in its current
  // state, with 200 rather than 201 since nothing new was placed. The same key on a different
  // order is the client's bug, and guessing which one they meant could trade the wrong thing.
  async function replyToRepeat(
    reply: FastifyReply,
    userId: string,
    orderId: string,
    asked: { market: Market; side: Side; type: string; price: bigint | null; quantity: bigint },
  ) {
    const existing = await findOrder(db, userId, orderId);
    if (existing === undefined) {
      throw new Error(`order ${orderId} matched a client order id but has no row`);
    }
    const { market } = asked;
    const same =
      existing.market === market.symbol &&
      existing.side === asked.side &&
      existing.type === asked.type &&
      (existing.price === null ? null : fromNumeric(existing.price, market.quoteScale)) ===
        asked.price &&
      fromNumeric(existing.quantity, market.baseScale) === asked.quantity;
    if (!same) {
      return reply.code(409).send({
        error: "client_order_id_reused",
        message: `client order id belongs to order ${existing.id}, which differs from this one`,
      });
    }

    const { createdAt: _createdAt, updatedAt: _updatedAt, ...order } = orderJson(existing, market);
    const fills = await takerFills(db, existing.id);
    return reply.code(200).send({
      ...order,
      fills: fills.map((fill) => ({
        price: rescale(fill.price, market.quoteScale),
        quantity: rescale(fill.quantity, market.baseScale),
      })),
    });
  }

  app.post("/orders", { onRequest: authenticate }, async (request, reply) => {
    const userId = authenticatedUserId(request);
    // Counted before validation, so malformed requests use up the allowance too.
    if (!(await underOrderLimit(request, reply, userId))) {
      metrics.order(NO_MARKET, "rate_limited");
      return reply;
    }

    const parsed = orderBody.safeParse(request.body);
    if (!parsed.success) {
      metrics.order(NO_MARKET, "invalid");
      return reply.code(400).send(invalidRequest(parsed.error));
    }
    const body = parsed.data;

    const market = await loadMarket(db, body.market);
    if (market === undefined) {
      metrics.order(NO_MARKET, "invalid");
      return reply.code(400).send(fieldError("market", "is not a listed market"));
    }
    // Past here the market is a listed one, so its symbol is a bounded label.
    const count = (outcome: OrderOutcome) => metrics.order(market.symbol, outcome);

    let price: bigint | null = null;
    if (body.type === "limit") {
      const parsedPrice = parseAmount(body.price, market.quoteScale);
      if (!parsedPrice.ok) {
        count("invalid");
        return reply.code(400).send(fieldError("price", AMOUNT_MESSAGES[parsedPrice.reason]));
      }
      price = parsedPrice.units;
    }
    const quantity = parseAmount(body.quantity, market.baseScale);
    if (!quantity.ok) {
      count("invalid");
      return reply.code(400).send(fieldError("quantity", AMOUNT_MESSAGES[quantity.reason]));
    }

    const fields = {
      userId,
      side: body.side,
      quantity: quantity.units,
      clientOrderId: body.clientOrderId,
    };
    let placed;
    try {
      placed = await exchange.placeOrder(
        market,
        price === null ? { ...fields, type: "market" } : { ...fields, type: "limit", price },
      );
    } catch (error) {
      if (error instanceof DuplicateOrderError) {
        count("repeat");
        return replyToRepeat(reply, userId, error.orderId, {
          market,
          side: body.side,
          type: body.type,
          price,
          quantity: quantity.units,
        });
      }
      if (error instanceof MarketHaltedError || error instanceof MarketBusyError) {
        count(error instanceof MarketBusyError ? "busy" : "halted");
        return unavailable(reply, error);
      }
      if (!(error instanceof OrderError)) {
        throw error;
      }
      count("rejected");
      if (error.code === "insufficient_funds" || error.code === "no_liquidity") {
        return reply.code(422).send({ error: error.code, message: error.message });
      }
      const [field, message] = GRID_ERRORS[error.code];
      return reply.code(400).send(fieldError(field, message));
    }

    count(placed.status);
    const quote = (units: bigint) => formatAmount(units, market.quoteScale);
    const base = (units: bigint) => formatAmount(units, market.baseScale);
    return reply.code(201).send({
      id: placed.id,
      market: market.symbol,
      side: body.side,
      type: body.type,
      price: price === null ? null : quote(price),
      quantity: base(quantity.units),
      clientOrderId: body.clientOrderId ?? null,
      status: placed.status,
      filledQuantity: base(placed.filledQuantity),
      fills: placed.fills.map((fill) => ({
        price: quote(fill.price),
        quantity: base(fill.quantity),
      })),
    });
  });

  app.delete("/orders/:id", { onRequest: authenticate }, async (request, reply) => {
    const userId = authenticatedUserId(request);

    const parsed = orderParams.safeParse(request.params);
    if (!parsed.success) {
      return reply.code(400).send(invalidRequest(parsed.error));
    }

    const order = await findOrder(db, userId, parsed.data.id);
    if (order === undefined) {
      return reply.code(404).send({ error: "not_found" });
    }
    const market = marketOf(await loadMarkets(db), order.market);

    let outcome;
    try {
      outcome = await exchange.cancelOrder(market, order.id);
    } catch (error) {
      if (error instanceof MarketHaltedError || error instanceof MarketBusyError) {
        return unavailable(reply, error);
      }
      throw error;
    }
    // Read back after the queue has run the cancel, so the status and filled quantity are
    // what settlement wrote, including any fill that landed just before.
    const current = await findOrder(db, userId, order.id);
    if (current === undefined) {
      throw new Error(`order ${order.id} disappeared while being cancelled`);
    }
    if (outcome === "not_open") {
      return reply
        .code(409)
        .send({ error: "order_not_open", message: `order is ${current.status}` });
    }
    return reply.code(200).send(orderJson(current, market));
  });

  app.get("/orders", { onRequest: authenticate }, async (request, reply) => {
    const userId = authenticatedUserId(request);

    const parsed = ordersQuery.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send(invalidRequest(parsed.error));
    }

    const [markets, rows] = await Promise.all([
      loadMarkets(db),
      listOrders(db, userId, parsed.data),
    ]);
    return reply.code(200).send({
      orders: rows.map((row) => orderJson(row, marketOf(markets, row.market))),
    });
  });

  app.get("/fills", { onRequest: authenticate }, async (request, reply) => {
    const userId = authenticatedUserId(request);

    const parsed = fillsQuery.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send(invalidRequest(parsed.error));
    }

    const [markets, rows] = await Promise.all([
      loadMarkets(db),
      listFills(db, userId, parsed.data),
    ]);
    return reply.code(200).send({
      fills: rows.map((row) => {
        const market = marketOf(markets, row.market);
        return {
          tradeId: row.tradeId,
          market: row.market,
          orderId: row.orderId,
          side: row.side,
          role: row.role,
          price: rescale(row.price, market.quoteScale),
          quantity: rescale(row.quantity, market.baseScale),
          createdAt: row.createdAt.toISOString(),
        };
      }),
    });
  });
}
