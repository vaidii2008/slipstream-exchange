// Reading the user's orders back, and cancelling one. Placing lives in orders.ts.
//
// Open orders are a REST list kept current by the account channel's order events, merged so
// that an order only moves forward (see account.ts). The list refetches when an order it has
// never seen appears, and after a reconnect, which may have missed events.

import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import type { Side } from "@slipstream/protocol";
import { isOpen, type OrderStatus, useOrderUpdates, withUpdates } from "./account";
import type { OrderType } from "./orders";
import { apiFetch } from "./session";
import { useConnection } from "./socket";

// An order as GET /orders and DELETE /orders/:id return it.
export type OrderRecord = {
  id: string;
  market: string;
  side: Side;
  type: OrderType;
  price: string | null;
  quantity: string;
  filledQuantity: string;
  status: OrderStatus;
  clientOrderId: string | null;
  createdAt: string;
  updatedAt: string;
};

// The API's own cap on one page.
export const OPEN_ORDERS_SHOWN = 500;

// Every private query sits under "account", so signing out can drop them all at once.
export const OPEN_ORDERS_KEY = ["account", "orders", "open"] as const;

export function useOpenOrders() {
  const query = useQuery({
    queryKey: OPEN_ORDERS_KEY,
    queryFn: async () =>
      (
        await apiFetch<{ orders: OrderRecord[] }>(
          `/orders?status=open&limit=${OPEN_ORDERS_SHOWN}`,
          { auth: true },
        )
      ).orders,
  });
  const updates = useOrderUpdates((state) => state.updates);
  const newOrders = useOrderUpdates((state) => state.newOrders);
  const reconnects = useConnection((state) => state.reconnects);
  const status = useConnection((state) => state.status);

  const { refetch } = query;
  useEffect(() => {
    if (newOrders > 0) {
      void refetch();
    }
  }, [newOrders, refetch]);
  useEffect(() => {
    if (reconnects > 0 && status === "open") {
      void refetch();
    }
  }, [reconnects, status, refetch]);

  const orders = useMemo(
    () => (query.data === undefined ? undefined : withUpdates(query.data, updates).filter(isOpen)),
    [query.data, updates],
  );
  return { orders, isError: query.isError };
}

// The order as the cancel left it, reported to the update store so the row goes at once,
// without waiting for the event.
export async function cancelOrder(id: string): Promise<OrderRecord> {
  const order = await apiFetch<OrderRecord>(`/orders/${id}`, { method: "DELETE", auth: true });
  useOrderUpdates.getState().report(order.id, order);
  return order;
}
