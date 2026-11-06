"use client";

import { useSubscription } from "@/lib/socket";
import { decimalsOf, display, type MarketInfo } from "@/lib/markets";
import { useFills, useOrderHistory } from "@/lib/history";

// Shown at the market's precision; a market missing from the listing falls back to full scale.
function precision(markets: MarketInfo[], symbol: string) {
  const market = markets.find((listed) => listed.symbol === symbol);
  return {
    price: market === undefined ? 8 : decimalsOf(market.tickSize),
    quantity: market === undefined ? 8 : decimalsOf(market.quantityStep),
  };
}

const sideClass = (side: "buy" | "sell") => (side === "buy" ? "text-emerald-600" : "text-red-600");

function Notice({ children, error = false }: { children: React.ReactNode; error?: boolean }) {
  return (
    <p className={`px-3 py-2 text-xs ${error ? "text-destructive" : "text-muted-foreground"}`}>
      {children}
    </p>
  );
}

export function OrderHistory({ markets }: { markets: MarketInfo[] }) {
  useSubscription("account");
  const { orders, isError } = useOrderHistory();

  if (isError) {
    return <Notice error>Could not load your order history.</Notice>;
  }
  if (orders === undefined) {
    return <Notice>Loading order history…</Notice>;
  }
  if (orders.length === 0) {
    return <Notice>No filled or cancelled orders yet.</Notice>;
  }
  return (
    <table className="w-full text-sm tabular-nums">
      <thead className="text-xs text-muted-foreground">
        <tr>
          <th className="px-3 pb-1 text-left font-normal">Time</th>
          <th className="px-3 pb-1 text-left font-normal">Market</th>
          <th className="px-3 pb-1 text-left font-normal">Side</th>
          <th className="px-3 pb-1 text-right font-normal">Price</th>
          <th className="px-3 pb-1 text-right font-normal">Filled / size</th>
          <th className="px-3 pb-1 text-left font-normal">Status</th>
        </tr>
      </thead>
      <tbody>
        {orders.map((order) => {
          const decimals = precision(markets, order.market);
          return (
            <tr key={order.id}>
              <td className="px-3 py-1 text-muted-foreground">
                <time dateTime={order.updatedAt}>{new Date(order.updatedAt).toLocaleString()}</time>
              </td>
              <td className="px-3 py-1">{order.market}</td>
              <td className={`px-3 py-1 ${sideClass(order.side)}`}>
                {order.side === "buy" ? "Buy" : "Sell"} {order.type}
              </td>
              <td className="px-3 py-1 text-right">
                {order.price === null ? "Market" : display(order.price, decimals.price)}
              </td>
              <td className="px-3 py-1 text-right">
                {display(order.filledQuantity, decimals.quantity)} /{" "}
                {display(order.quantity, decimals.quantity)}
              </td>
              <td className="px-3 py-1 text-muted-foreground">{order.status}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function Fills({ markets }: { markets: MarketInfo[] }) {
  useSubscription("account");
  const { fills, isError } = useFills();

  if (isError) {
    return <Notice error>Could not load your fills.</Notice>;
  }
  if (fills === undefined) {
    return <Notice>Loading fills…</Notice>;
  }
  if (fills.length === 0) {
    return <Notice>No fills yet.</Notice>;
  }
  return (
    <table className="w-full text-sm tabular-nums">
      <thead className="text-xs text-muted-foreground">
        <tr>
          <th className="px-3 pb-1 text-left font-normal">Time</th>
          <th className="px-3 pb-1 text-left font-normal">Market</th>
          <th className="px-3 pb-1 text-left font-normal">Side</th>
          <th className="px-3 pb-1 text-right font-normal">Price</th>
          <th className="px-3 pb-1 text-right font-normal">Quantity</th>
          <th className="px-3 pb-1 text-left font-normal">Role</th>
        </tr>
      </thead>
      <tbody>
        {fills.map((fill) => {
          const decimals = precision(markets, fill.market);
          return (
            <tr key={fill.tradeId}>
              <td className="px-3 py-1 text-muted-foreground">
                <time dateTime={fill.createdAt}>{new Date(fill.createdAt).toLocaleString()}</time>
              </td>
              <td className="px-3 py-1">{fill.market}</td>
              <td className={`px-3 py-1 ${sideClass(fill.side)}`}>
                {fill.side === "buy" ? "Buy" : "Sell"}
              </td>
              <td className="px-3 py-1 text-right">{display(fill.price, decimals.price)}</td>
              <td className="px-3 py-1 text-right">{display(fill.quantity, decimals.quantity)}</td>
              <td className="px-3 py-1 text-muted-foreground">{fill.role}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
