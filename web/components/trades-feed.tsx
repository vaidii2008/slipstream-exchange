"use client";

import { useQuery } from "@tanstack/react-query";
import { memo, useEffect } from "react";
import { decimalsOf, display, type MarketInfo } from "@/lib/markets";
import { apiFetch } from "@/lib/session";
import { useConnection, useSubscription } from "@/lib/socket";
import { liveTrades, mergeTrades, type Trade, TRADES_SHOWN, useTrades } from "@/lib/trades";

type HistoryTrade = Omit<Trade, "time"> & { createdAt: string };

const TradeRow = memo(function TradeRow({
  trade,
  priceDecimals,
  quantityDecimals,
}: {
  trade: Trade;
  priceDecimals: number;
  quantityDecimals: number;
}) {
  return (
    <li className="grid animate-flash grid-cols-3 px-3 py-0.5 tabular-nums">
      {/* The taker's side: green when a buyer lifted an ask, red when a seller hit a bid. */}
      <span className={trade.takerSide === "buy" ? "text-emerald-600" : "text-red-600"}>
        {display(trade.price, priceDecimals)}
      </span>
      <span className="text-right">{display(trade.quantity, quantityDecimals)}</span>
      <time dateTime={trade.time} className="text-right text-muted-foreground">
        {new Date(trade.time).toLocaleTimeString()}
      </time>
    </li>
  );
});

export function TradesFeed({ market }: { market: MarketInfo }) {
  const { symbol } = market;
  useSubscription("trades", symbol);
  const live = useTrades(liveTrades(symbol));
  const reconnects = useConnection((state) => state.reconnects);
  const status = useConnection((state) => state.status);

  const history = useQuery({
    queryKey: ["trades", symbol],
    queryFn: async () => {
      const { trades } = await apiFetch<{ trades: HistoryTrade[] }>(
        `/markets/${symbol}/trades?limit=${TRADES_SHOWN}`,
      );
      return trades.map(({ createdAt, ...trade }) => ({ ...trade, time: createdAt }));
    },
  });

  // Back after a drop: the live list was cleared, so load what settled in the meantime.
  const { refetch } = history;
  useEffect(() => {
    if (reconnects > 0 && status === "open") {
      void refetch();
    }
  }, [reconnects, status, refetch]);

  const trades = mergeTrades(history.data ?? [], live);
  const priceDecimals = decimalsOf(market.tickSize);
  const quantityDecimals = decimalsOf(market.quantityStep);

  return (
    <section aria-label="Recent trades" className="flex flex-col text-sm">
      <header className="px-3 py-2">
        <h2 className="font-medium">Trades</h2>
      </header>
      <div className="grid grid-cols-3 px-3 pb-1 text-xs text-muted-foreground">
        <span>Price ({market.quoteAsset})</span>
        <span className="text-right">Size ({market.baseAsset})</span>
        <span className="text-right">Time</span>
      </div>
      {history.isError ? (
        <p className="px-3 text-xs text-destructive">Could not load recent trades.</p>
      ) : null}
      <ol>
        {trades.map((trade) => (
          <TradeRow
            key={trade.sequence}
            trade={trade}
            priceDecimals={priceDecimals}
            quantityDecimals={quantityDecimals}
          />
        ))}
      </ol>
    </section>
  );
}
