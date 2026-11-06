// Reading a user's orders back: one order by id, and the lists behind the order and fill
// screens. Accepting an order lives in orders.ts.

import { and, desc, eq, inArray, or, type SQL } from "drizzle-orm";
import type { Side } from "./book.ts";
import type { Database } from "./ledger.ts";
import { orders, trades } from "./schema.ts";

// An order as stored. Amounts are NUMERIC strings; the caller converts them at the market's
// scales.
export const orderColumns = {
  id: orders.id,
  market: orders.market,
  side: orders.side,
  type: orders.type,
  price: orders.price,
  quantity: orders.quantity,
  filledQuantity: orders.filledQuantity,
  status: orders.status,
  createdAt: orders.createdAt,
  updatedAt: orders.updatedAt,
};

export type OrderRow = {
  id: string;
  market: string;
  side: Side;
  type: "limit" | "market";
  price: string | null;
  quantity: string;
  filledQuantity: string;
  status: "pending" | "open" | "filled" | "cancelled";
  createdAt: Date;
  updatedAt: Date;
};

// Undefined when there is no such order or it belongs to someone else: the caller cannot
// tell the two apart, so order ids reveal nothing about other users.
export async function findOrder(
  db: Database,
  userId: string,
  orderId: string,
): Promise<OrderRow | undefined> {
  const [row] = await db
    .select(orderColumns)
    .from(orders)
    .where(and(eq(orders.id, orderId), eq(orders.userId, userId)))
    .limit(1);
  return row;
}

export type OrderListing = {
  // open: pending or resting. closed: filled or cancelled.
  status: "open" | "closed" | "all";
  market?: string | undefined;
  limit: number;
};

const STATUSES = {
  open: ["pending", "open"],
  closed: ["filled", "cancelled"],
} as const;

// Newest first. The id breaks ties between orders created in the same microsecond.
export async function listOrders(
  db: Database,
  userId: string,
  { status, market, limit }: OrderListing,
): Promise<OrderRow[]> {
  const conditions: SQL[] = [eq(orders.userId, userId)];
  if (status !== "all") {
    conditions.push(inArray(orders.status, [...STATUSES[status]]));
  }
  if (market !== undefined) {
    conditions.push(eq(orders.market, market));
  }
  return db
    .select(orderColumns)
    .from(orders)
    .where(and(...conditions))
    .orderBy(desc(orders.createdAt), desc(orders.id))
    .limit(limit);
}

// One of the user's executions: their side of one trade.
export type FillRow = {
  tradeId: number;
  market: string;
  orderId: string;
  side: Side;
  // Maker: the user's order was resting. Taker: it arrived and crossed.
  role: "maker" | "taker";
  price: string;
  quantity: string;
  createdAt: Date;
};

// Newest first. Self-trade prevention means a user is never both sides of one trade, so each
// trade appears at most once.
export async function listFills(
  db: Database,
  userId: string,
  { market, limit }: { market?: string | undefined; limit: number },
): Promise<FillRow[]> {
  const conditions: SQL[] = [eq(orders.userId, userId)];
  if (market !== undefined) {
    conditions.push(eq(trades.market, market));
  }
  const rows = await db
    .select({
      tradeId: trades.id,
      market: trades.market,
      orderId: orders.id,
      side: orders.side,
      makerOrderId: trades.makerOrderId,
      price: trades.price,
      quantity: trades.quantity,
      createdAt: trades.createdAt,
    })
    .from(trades)
    .innerJoin(orders, or(eq(orders.id, trades.makerOrderId), eq(orders.id, trades.takerOrderId)))
    .where(and(...conditions))
    .orderBy(desc(trades.id))
    .limit(limit);
  return rows.map(({ makerOrderId, ...row }) => ({
    ...row,
    role: row.orderId === makerOrderId ? "maker" : "taker",
  }));
}
