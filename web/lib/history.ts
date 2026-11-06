// Reading the user's orders back, and cancelling one. Placing lives in orders.ts.
//
// Open orders are a REST list kept current by the account channel's order events, merged so
// that an order only moves forward (see account.ts). The list refetches when an order it has
// never seen appears, and after a reconnect, which may have missed events.
//
// History and fills are plain REST lists. Closed orders and past trades never change, but new
// ones appear, so both refetch after any order event and after a reconnect, and only while
// they are on screen.

import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef } from "react";
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

export const HISTORY_SHOWN = 100;

export const ORDER_HISTORY_KEY = ["account", "orders", "closed"] as const;
export const FILLS_KEY = ["account", "fills"] as const;

// The user's side of one trade, as GET /fills returns it.
export type Fill = {
  tradeId: number;
  market: string;
  orderId: string;
  side: Side;
  // Maker: the user's order was resting. Taker: it arrived and crossed.
  role: "maker" | "taker";
  price: string;
  quantity: string;
  createdAt: string;
};

// Refetch whenever an order event or a reconnect has happened since the component mounted,
// once the socket is open. Not on mount itself: the query is already fetching then.
function useRefetchOnOrderEvents(refetch: () => Promise<unknown>): void {
  const updates = useOrderUpdates((state) => state.updates);
  const reconnects = useConnection((state) => state.reconnects);
  const status = useConnection((state) => state.status);
  const atMount = useRef({ updates, reconnects });

  useEffect(() => {
    const changed =
      updates !== atMount.current.updates || reconnects !== atMount.current.reconnects;
    if (changed && status === "open") {
      void refetch();
    }
  }, [updates, reconnects, status, refetch]);
}

export function useOrderHistory() {
  const query = useQuery({
    queryKey: ORDER_HISTORY_KEY,
    queryFn: async () =>
      (
        await apiFetch<{ orders: OrderRecord[] }>(`/orders?status=closed&limit=${HISTORY_SHOWN}`, {
          auth: true,
        })
      ).orders,
  });
  useRefetchOnOrderEvents(query.refetch);
  return { orders: query.data, isError: query.isError };
}

export function useFills() {
  const query = useQuery({
    queryKey: FILLS_KEY,
    queryFn: async () =>
      (await apiFetch<{ fills: Fill[] }>(`/fills?limit=${HISTORY_SHOWN}`, { auth: true })).fills,
  });
  useRefetchOnOrderEvents(query.refetch);
  return { fills: query.data, isError: query.isError };
}
