"use client";

import { useQuery } from "@tanstack/react-query";
import { CandlestickSeries, createChart, type ISeriesApi } from "lightweight-charts";
import { useEffect, useMemo, useRef } from "react";
import {
  type Candle,
  CANDLES_SHOWN,
  chartBar,
  chartChange,
  liveCandles,
  mergeCandles,
  useCandles,
} from "@/lib/candles";
import { decimalsOf, type MarketInfo } from "@/lib/markets";
import { apiFetch } from "@/lib/session";
import { useConnection, useSubscription } from "@/lib/socket";

// The trades feed's green and red, so a rising candle and a buy look alike.
const UP = "#059669";
const DOWN = "#dc2626";

export function CandleChart({ market }: { market: MarketInfo }) {
  const { symbol, tickSize } = market;
  useSubscription("candles", symbol);
  const live = useCandles(liveCandles(symbol));
  const reconnects = useConnection((state) => state.reconnects);
  const status = useConnection((state) => state.status);

  const history = useQuery({
    queryKey: ["candles", symbol],
    queryFn: async () =>
      (await apiFetch<{ candles: Candle[] }>(`/markets/${symbol}/candles?limit=${CANDLES_SHOWN}`))
        .candles,
  });

  // Back after a drop: load the minutes that traded while the socket was down.
  const { refetch } = history;
  useEffect(() => {
    if (reconnects > 0 && status === "open") {
      void refetch();
    }
  }, [reconnects, status, refetch]);

  const candles = useMemo(() => mergeCandles(history.data ?? [], live), [history.data, live]);

  const container = useRef<HTMLDivElement>(null);
  const series = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const shown = useRef<Candle[]>([]);

  // A new chart per market, so one market's bars never show under another's prices.
  useEffect(() => {
    const element = container.current;
    if (element === null) {
      return;
    }
    const chart = createChart(element, {
      autoSize: true,
      layout: {
        background: { color: "transparent" },
        textColor: getComputedStyle(element).color,
        attributionLogo: false,
      },
      grid: { vertLines: { visible: false }, horzLines: { color: "rgba(128, 128, 128, 0.15)" } },
      timeScale: { timeVisible: true, secondsVisible: false },
    });
    series.current = chart.addSeries(CandlestickSeries, {
      upColor: UP,
      downColor: DOWN,
      wickUpColor: UP,
      wickDownColor: DOWN,
      borderVisible: false,
      priceFormat: { type: "price", precision: decimalsOf(tickSize), minMove: Number(tickSize) },
    });
    shown.current = [];
    return () => {
      chart.remove();
      series.current = null;
      shown.current = [];
    };
  }, [symbol, tickSize]);

  useEffect(() => {
    const target = series.current;
    if (target === null) {
      return;
    }
    const change = chartChange(shown.current, candles);
    if (change.kind === "set") {
      target.setData(candles.map(chartBar));
    } else if (change.kind === "update") {
      target.update(chartBar(change.candle));
    }
    shown.current = candles;
  }, [symbol, candles]);

  return (
    <section aria-label={`${symbol} one-minute candles`} className="border-b text-sm">
      <header className="flex items-baseline gap-2 px-3 pt-2">
        <h2 className="font-medium">{symbol}</h2>
        <span className="text-xs text-muted-foreground">1m candles, UTC</span>
        {history.isError ? (
          <span className="text-xs text-destructive">Could not load candles.</span>
        ) : history.isSuccess && candles.length === 0 ? (
          <span className="text-xs text-muted-foreground">No trades yet.</span>
        ) : null}
      </header>
      <div ref={container} className="h-72 text-muted-foreground" />
    </section>
  );
}
