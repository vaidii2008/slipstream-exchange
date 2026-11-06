// Reading a user's orders back: one order by id, and the lists behind the order and fill
// screens. Accepting an order lives in orders.ts.

import { and, eq } from "drizzle-orm";
import type { Side } from "./book.ts";
import type { Database } from "./ledger.ts";
import { orders } from "./schema.ts";

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
