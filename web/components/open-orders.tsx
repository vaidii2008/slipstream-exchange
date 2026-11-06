"use client";

import { useMutation } from "@tanstack/react-query";
import { memo } from "react";
import { Button } from "@/components/ui/button";
import { decimalsOf, display, type MarketInfo } from "@/lib/markets";
import { cancelOrder, type OrderRecord, useOpenOrders } from "@/lib/history";
import { ApiError } from "@/lib/session";
import { useSubscription } from "@/lib/socket";

const CANCEL_MESSAGES: Record<string, string> = {
  order_not_open: "Already closed",
  market_busy: "Market busy, try again",
  market_halted: "Market halted",
  rate_limited: "Too many requests",
};

function cancelFailure(error: unknown): string {
  return error instanceof ApiError
    ? (CANCEL_MESSAGES[error.code] ?? error.message)
    : "Could not reach the exchange";
}

const OpenOrderRow = memo(function OpenOrderRow({
  order,
  market,
}: {
  order: OrderRecord;
  market: MarketInfo | undefined;
}) {
  const cancel = useMutation({ mutationFn: () => cancelOrder(order.id) });
  const priceDecimals = market === undefined ? 8 : decimalsOf(market.tickSize);
  const quantityDecimals = market === undefined ? 8 : decimalsOf(market.quantityStep);

  return (
    <tr>
      <td className="px-3 py-1">{order.market}</td>
      <td className={`px-3 py-1 ${order.side === "buy" ? "text-emerald-600" : "text-red-600"}`}>
        {order.side === "buy" ? "Buy" : "Sell"}
      </td>
      <td className="px-3 py-1 text-right">
        {order.price === null ? "Market" : display(order.price, priceDecimals)}
      </td>
      <td className="px-3 py-1 text-right">
        {display(order.filledQuantity, quantityDecimals)} /{" "}
        {display(order.quantity, quantityDecimals)}
      </td>
      <td className="px-3 py-1 text-muted-foreground">{order.status}</td>
      <td className="px-3 py-1 text-right">
        {cancel.isError ? (
          <span className="mr-2 text-xs text-destructive">{cancelFailure(cancel.error)}</span>
        ) : null}
        <Button
          variant="outline"
          size="xs"
          disabled={cancel.isPending}
          onClick={() => cancel.mutate()}
          aria-label={`Cancel ${order.side} ${order.quantity} ${order.market}`}
        >
          {cancel.isPending ? "Cancelling…" : "Cancel"}
        </Button>
      </td>
    </tr>
  );
});

export function OpenOrders({ markets }: { markets: MarketInfo[] }) {
  useSubscription("account");
  const { orders, isError } = useOpenOrders();

  if (isError) {
    return <p className="px-3 py-2 text-xs text-destructive">Could not load your open orders.</p>;
  }
  if (orders === undefined) {
    return <p className="px-3 py-2 text-xs text-muted-foreground">Loading open orders…</p>;
  }
  if (orders.length === 0) {
    return <p className="px-3 py-2 text-xs text-muted-foreground">No open orders.</p>;
  }
  return (
    <table className="w-full text-sm tabular-nums">
      <thead className="text-xs text-muted-foreground">
        <tr>
          <th className="px-3 pb-1 text-left font-normal">Market</th>
          <th className="px-3 pb-1 text-left font-normal">Side</th>
          <th className="px-3 pb-1 text-right font-normal">Price</th>
          <th className="px-3 pb-1 text-right font-normal">Filled / size</th>
          <th className="px-3 pb-1 text-left font-normal">Status</th>
          <th className="px-3 pb-1" />
        </tr>
      </thead>
      <tbody>
        {orders.map((order) => (
          <OpenOrderRow
            key={order.id}
            order={order}
            market={markets.find((listed) => listed.symbol === order.market)}
          />
        ))}
      </tbody>
    </table>
  );
}
