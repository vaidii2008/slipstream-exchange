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
  | "insufficient_funds";

// A rejection the client caused and can fix. Anything else thrown from here is our bug.
export class OrderError extends Error {
  readonly code: OrderErrorCode;

  constructor(code: OrderErrorCode, message: string) {
    super(message);
    this.name = "OrderError";
    this.code = code;
  }
}

export type LimitOrderRequest = {
  userId: string;
  side: Side;
  // Minor units: price at the quote scale, quantity at the base scale.
  price: bigint;
  quantity: bigint;
};

export type RecordedOrder = LimitOrderRequest & { id: string; market: Market };

// The grid is what keeps every fill's notional exact, so an order off it never reaches the
// ledger or the engine.
function checkGrid(market: Market, price: bigint, quantity: bigint): void {
  if (price <= 0n) {
    throw new OrderError("price_not_positive", "price must be positive");
  }
  if (price % market.tickSize !== 0n) {
    throw new OrderError("price_off_tick", `price must be a multiple of the tick size`);
  }
  if (quantity < market.minQuantity) {
    throw new OrderError("quantity_below_minimum", "quantity is below the market minimum");
  }
  if (quantity % market.quantityStep !== 0n) {
    throw new OrderError("quantity_off_step", "quantity must be a multiple of the step");
  }
}

// The most a limit order can spend: a buy pays at most its own price for every unit, a sell
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
export async function recordLimitOrder(
  db: Database,
  market: Market,
  request: LimitOrderRequest,
): Promise<RecordedOrder> {
  const { userId, side, price, quantity } = request;
  checkGrid(market, price, quantity);
  const reservation = reservationFor(market, side, price, quantity);

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
        type: "limit",
        price: formatAmount(price, market.quoteScale),
        quantity: formatAmount(quantity, market.baseScale),
      })
      .returning({ id: orders.id });
    if (row === undefined) {
      throw new Error("order insert returned no row");
    }
    return { ...request, id: row.id, market };
  });
}
