// Accepting an order: checks it against its market's grid, reserves what it could spend and
// records it, before the engine sees it. Matching and settlement live in exchange.ts.

import { eq } from "drizzle-orm";
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

export async function loadMarket(db: Database, symbol: string): Promise<Market | undefined> {
  const [row] = await db
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
    .where(eq(markets.symbol, symbol))
    .limit(1);
  if (row === undefined) {
    return undefined;
  }
  return {
    ...row,
    tickSize: fromNumeric(row.tickSize, row.quoteScale),
    quantityStep: fromNumeric(row.quantityStep, row.baseScale),
    minQuantity: fromNumeric(row.minQuantity, row.baseScale),
  };
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

type OrderFields = {
  userId: string;
  side: Side;
  // Minor units at the base scale.
  quantity: bigint;
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

// Phase one of placing an order: reserve and record in one transaction, so there is never
// a reservation without its order or an order without its reservation. The order is left
// pending for the engine.
export async function recordOrder(
  db: Database,
  market: Market,
  order: AcceptedOrder,
): Promise<{ id: string }> {
  const { userId, side, quantity } = order;
  checkGrid(market, order);
  const reservation = reservationFor(market, side, worstPrice(order), quantity);

  return db.transaction(async (tx) => {
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

    const [row] = await tx
      .insert(orders)
      .values({
        userId,
        market: market.symbol,
        side,
        type: order.type,
        // The protection price is not the order's price: a market order has none.
        price: order.type === "limit" ? formatAmount(order.price, market.quoteScale) : null,
        quantity: formatAmount(quantity, market.baseScale),
      })
      .returning({ id: orders.id });
    if (row === undefined) {
      throw new Error("order insert returned no row");
    }
    return { id: row.id };
  });
}
