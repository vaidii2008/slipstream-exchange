// The order API. It needs both orders.ts (markets, rejections) and exchange.ts (placing), and
// exchange.ts already imports orders.ts, so the routes live here rather than in either.

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticatedUserId, bearerAuth, invalidRequest } from "./auth.ts";
import type { Exchange } from "./exchange.ts";
import type { Database } from "./ledger.ts";
import { formatAmount, fromNumeric, parseAmount } from "./money.ts";
import { findOrder, type OrderRow } from "./history.ts";
import { loadMarket, type Market, OrderError, type OrderErrorCode } from "./orders.ts";
import type { AccessTokens } from "./tokens.ts";
import { AMOUNT_MESSAGES, fieldError } from "./wallet.ts";

export type TradingDependencies = {
  db: Database;
  tokens: AccessTokens;
  exchange: Exchange;
};

// Prices and quantities travel as strings, like deposit amounts. A market order has no price,
// and sending one is rejected rather than ignored: the client may think it set a limit.
const orderFields = {
  market: z.string().min(1).max(32),
  side: z.enum(["buy", "sell"]),
  quantity: z.string().max(64),
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

// Postgres pads NUMERIC to 18 decimals; clients see the asset's own scale, as on placement.
function orderJson(row: OrderRow, market: Market) {
  const rescale = (value: string, scale: number) => formatAmount(fromNumeric(value, scale), scale);
  return {
    id: row.id,
    market: row.market,
    side: row.side,
    type: row.type,
    price: row.price === null ? null : rescale(row.price, market.quoteScale),
    quantity: rescale(row.quantity, market.baseScale),
    filledQuantity: rescale(row.filledQuantity, market.baseScale),
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function marketOf(db: Database, row: OrderRow): Promise<Market> {
  const market = await loadMarket(db, row.market);
  if (market === undefined) {
    throw new Error(`order ${row.id} is in market ${row.market}, which is not listed`);
  }
  return market;
}

export function registerTradingRoutes(
  app: FastifyInstance,
  { db, tokens, exchange }: TradingDependencies,
) {
  const authenticate = bearerAuth(tokens);

  app.post("/orders", { onRequest: authenticate }, async (request, reply) => {
    const userId = authenticatedUserId(request);

    const parsed = orderBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send(invalidRequest(parsed.error));
    }
    const body = parsed.data;

    const market = await loadMarket(db, body.market);
    if (market === undefined) {
      return reply.code(400).send(fieldError("market", "is not a listed market"));
    }

    let price: bigint | null = null;
    if (body.type === "limit") {
      const parsedPrice = parseAmount(body.price, market.quoteScale);
      if (!parsedPrice.ok) {
        return reply.code(400).send(fieldError("price", AMOUNT_MESSAGES[parsedPrice.reason]));
      }
      price = parsedPrice.units;
    }
    const quantity = parseAmount(body.quantity, market.baseScale);
    if (!quantity.ok) {
      return reply.code(400).send(fieldError("quantity", AMOUNT_MESSAGES[quantity.reason]));
    }

    const fields = { userId, side: body.side, quantity: quantity.units };
    let placed;
    try {
      placed = await exchange.placeOrder(
        market,
        price === null ? { ...fields, type: "market" } : { ...fields, type: "limit", price },
      );
    } catch (error) {
      if (!(error instanceof OrderError)) {
        throw error;
      }
      if (error.code === "insufficient_funds" || error.code === "no_liquidity") {
        return reply.code(422).send({ error: error.code, message: error.message });
      }
      const [field, message] = GRID_ERRORS[error.code];
      return reply.code(400).send(fieldError(field, message));
    }

    const quote = (units: bigint) => formatAmount(units, market.quoteScale);
    const base = (units: bigint) => formatAmount(units, market.baseScale);
    return reply.code(201).send({
      id: placed.id,
      market: market.symbol,
      side: body.side,
      type: body.type,
      price: price === null ? null : quote(price),
      quantity: base(quantity.units),
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
    const market = await marketOf(db, order);

    const outcome = await exchange.cancelOrder(market, order.id);
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
}
