// Accepting an order: checks it against its market's grid, reserves what it could spend and
// records it, before the engine sees it. Matching and settlement live in exchange.ts.

import { and, eq } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Side } from "./book.ts";
import { type Database, LedgerError, reserve } from "./ledger.ts";
import { formatAmount, fromNumeric, notional } from "./money.ts";
import { assets, markets, orders } from "./schema.ts";

// A market with every amount already in minor units: prices and the tick at the quote
// asset's scale, quantities, the step and the minimum at the base asset's.
export type Market = {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  baseScale: number;
  quoteScale: number;
  tickSize: bigint;
  quantityStep: bigint;
  minQuantity: bigint;
};

const base = alias(assets, "base");
const quote = alias(assets, "quote");

// Every listed market, or the one named.
async function queryMarkets(db: Database, symbol?: string): Promise<Market[]> {
  const rows = await db
    .select({
      symbol: markets.symbol,
      baseAsset: markets.baseAsset,
      quoteAsset: markets.quoteAsset,
      baseScale: base.scale,
      quoteScale: quote.scale,
      tickSize: markets.tickSize,
      quantityStep: markets.quantityStep,
      minQuantity: markets.minQuantity,
    })
    .from(markets)
    .innerJoin(base, eq(base.code, markets.baseAsset))
    .innerJoin(quote, eq(quote.code, markets.quoteAsset))
    .where(symbol === undefined ? undefined : eq(markets.symbol, symbol));
  return rows.map((row) => ({
    ...row,
    tickSize: fromNumeric(row.tickSize, row.quoteScale),
    quantityStep: fromNumeric(row.quantityStep, row.baseScale),
    minQuantity: fromNumeric(row.minQuantity, row.baseScale),
  }));
}

export async function loadMarket(db: Database, symbol: string): Promise<Market | undefined> {
  const [market] = await queryMarkets(db, symbol);
  return market;
}

export async function loadMarkets(db: Database): Promise<Map<string, Market>> {
  return new Map((await queryMarkets(db)).map((market) => [market.symbol, market]));
}

export type OrderErrorCode =
  | "price_not_positive"
  | "price_off_tick"
  | "quantity_off_step"
  | "quantity_below_minimum"
  | "insufficient_funds"
  | "no_liquidity";

// A rejection the client caused and can fix. Anything else thrown from here is our bug.
export class OrderError extends Error {
  readonly code: OrderErrorCode;

  constructor(code: OrderErrorCode, message: string) {
    super(message);
    this.name = "OrderError";
    this.code = code;
  }
}

// An order this user already placed with the same client order id. Not a rejection of the
// order but of the repeat: the caller answers with the existing order.
export class DuplicateOrderError extends Error {
  readonly orderId: string;

  constructor(orderId: string) {
    super(`client order id already used by order ${orderId}`);
    this.name = "DuplicateOrderError";
    this.orderId = orderId;
  }
}

type OrderFields = {
  userId: string;
  side: Side;
  // Minor units at the base scale.
  quantity: bigint;
  // The client's own id for the order, unique per user: sending the same one again returns
  // the order already placed instead of placing a second.
  clientOrderId?: string | undefined;
};

// Price in minor units at the quote scale.
export type LimitOrderRequest = OrderFields & { type: "limit"; price: bigint };
export type MarketOrderRequest = OrderFields & { type: "market" };
export type OrderRequest = LimitOrderRequest | MarketOrderRequest;

// An order whose worst price is fixed: a limit order's own price, or the protection price a
// market order was given on arrival. A buy reserves at that price.
export type AcceptedOrder = LimitOrderRequest | (MarketOrderRequest & { protectionPrice: bigint });

export function worstPrice(order: AcceptedOrder): bigint {
  return order.type === "limit" ? order.price : order.protectionPrice;
}

// How far beyond the best opposite price a market order may trade, in percent.
export const MARKET_PROTECTION_PERCENT = 5n;

// A market order has no price of its own, so it gets a bound from the book as it stands on
// arrival: the best opposite price moved 5% against the taker, rounded towards it onto the
// tick grid. The bound caps what a buy reserves and how far either side can sweep a thin book.
export function protectionPrice(market: Market, side: Side, bestOpposite: bigint | undefined) {
  if (bestOpposite === undefined) {
    throw new OrderError("no_liquidity", `no ${side === "buy" ? "asks" : "bids"} to trade with`);
  }
  const band =
    ((bestOpposite * MARKET_PROTECTION_PERCENT) / 100n / market.tickSize) * market.tickSize;
  return side === "buy" ? bestOpposite + band : bestOpposite - band;
}

// The grid is what keeps every fill's notional exact, so an order off it never reaches the
// ledger or the engine.
function checkGrid(market: Market, order: AcceptedOrder): void {
  if (order.type === "limit") {
    if (order.price <= 0n) {
      throw new OrderError("price_not_positive", "price must be positive");
    }
    if (order.price % market.tickSize !== 0n) {
      throw new OrderError("price_off_tick", `price must be a multiple of the tick size`);
    }
  }
  const { quantity } = order;
  if (quantity < market.minQuantity) {
    throw new OrderError("quantity_below_minimum", "quantity is below the market minimum");
  }
  if (quantity % market.quantityStep !== 0n) {
    throw new OrderError("quantity_off_step", "quantity must be a multiple of the step");
  }
}

// The most an order can spend: a buy pays at most its worst price for every unit, a sell
// gives up at most its quantity.
export function reservationFor(
  market: Market,
  side: Side,
  price: bigint,
  quantity: bigint,
): { asset: string; amount: bigint } {
  return side === "buy"
    ? { asset: market.quoteAsset, amount: notional(price, quantity, market.baseScale) }
    : { asset: market.baseAsset, amount: quantity };
}

export async function orderIdForClientOrderId(
  db: Database,
  userId: string,
  clientOrderId: string,
): Promise<string | undefined> {
  const [row] = await db
    .select({ id: orders.id })
    .from(orders)
    .where(and(eq(orders.userId, userId), eq(orders.clientOrderId, clientOrderId)))
    .limit(1);
  return row?.id;
}

// Phase one of placing an order: reserve and record in one transaction, so there is never
// a reservation without its order or an order without its reservation. The order is left
// pending for the engine.
//
// The row goes in before the reservation so the unique (user, client order id) index decides
// races between repeats of one order. A second insert with the same key waits there until the
// first commits, then conflicts and reserves nothing. Reserving first, it could fail for
// insufficient funds because the first had just taken them.
export async function recordOrder(
  db: Database,
  market: Market,
  order: AcceptedOrder,
): Promise<{ id: string }> {
  const { userId, side, quantity } = order;
  checkGrid(market, order);
  const reservation = reservationFor(market, side, worstPrice(order), quantity);

  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(orders)
      .values({
        userId,
        market: market.symbol,
        side,
        type: order.type,
        // The protection price is not the order's price: a market order has none.
        price: order.type === "limit" ? formatAmount(order.price, market.quoteScale) : null,
        protectionPrice:
          order.type === "market" ? formatAmount(order.protectionPrice, market.quoteScale) : null,
        quantity: formatAmount(quantity, market.baseScale),
        clientOrderId: order.clientOrderId ?? null,
      })
      .onConflictDoNothing({ target: [orders.userId, orders.clientOrderId] })
      .returning({ id: orders.id });
    if (row === undefined) {
      const existing =
        order.clientOrderId === undefined
          ? undefined
          : await orderIdForClientOrderId(tx, userId, order.clientOrderId);
      if (existing === undefined) {
        throw new Error("order insert returned no row and conflicted with nothing");
      }
      throw new DuplicateOrderError(existing);
    }

    try {
      await reserve(tx, userId, reservation.asset, reservation.amount);
    } catch (error) {
      if (error instanceof LedgerError && error.code === "insufficient_funds") {
        throw new OrderError(
          "insufficient_funds",
          `not enough ${reservation.asset} available for this order`,
        );
      }
      throw error;
    }
    return { id: row.id };
  });
}
