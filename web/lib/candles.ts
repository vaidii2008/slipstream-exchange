// One-minute candles: history from REST, then the candle in progress from the candles channel.
//
// The server sends whole candles, never trades to fold, so merging needs no sequence numbers:
// of two copies of the same minute, the one with more trades is newer, because a candle only
// ever gains trades. That holds whichever way round REST and the socket arrive, and across a
// reconnect or an API restart, where engine sequences start again at 1.

import type { CandlestickData, UTCTimestamp } from "lightweight-charts";
import { create } from "zustand";
import type { Candle, ServerMessage } from "@slipstream/protocol";

export type { Candle };

export const CANDLES_SHOWN = 500;

// One per minute, oldest first, at most `limit` (the newest kept).
export function mergeCandles(history: Candle[], live: Candle[], limit = CANDLES_SHOWN): Candle[] {
  const byStart = new Map<string, Candle>();
  for (const candle of [...history, ...live]) {
    const kept = byStart.get(candle.start);
    if (kept === undefined || candle.trades > kept.trades) {
      byStart.set(candle.start, candle);
    }
  }
  // ISO strings in UTC sort in time order.
  return [...byStart.values()].sort((a, b) => a.start.localeCompare(b.start)).slice(-limit);
}

// What the chart has to do to go from showing `shown` to showing `next`. Redrawing every bar
// on each trade would reset the user's zoom and scroll, so a change to the last bar, or one
// new bar after it, is an update; anything else (first load, a gap filled after a
// reconnect) redraws.
export type ChartChange = { kind: "none" } | { kind: "update"; candle: Candle } | { kind: "set" };

export function chartChange(shown: Candle[], next: Candle[]): ChartChange {
  const last = next.at(-1);
  if (last === undefined) {
    return shown.length === 0 ? { kind: "none" } : { kind: "set" };
  }
  // Compared by identity: a merge keeps the same object for a candle that did not change.
  const earlierUnchanged = next.slice(0, -1).every((candle, index) => candle === shown[index]);
  if (earlierUnchanged && shown.length === next.length) {
    return shown.at(-1) === last ? { kind: "none" } : { kind: "update", candle: last };
  }
  if (earlierUnchanged && shown.length === next.length - 1) {
    return { kind: "update", candle: last };
  }
  return { kind: "set" };
}

// A bar for the chart library, which draws with numbers. Only pixels come from these floats:
// every price the terminal shows or sends stays a decimal string.
export function chartBar(candle: Candle): CandlestickData<UTCTimestamp> {
  return {
    time: (Date.parse(candle.start) / 1000) as UTCTimestamp,
    open: Number(candle.open),
    high: Number(candle.high),
    low: Number(candle.low),
    close: Number(candle.close),
  };
}

type CandleMessage = Extract<ServerMessage, { type: "candle" }>;

const NO_CANDLES: Candle[] = [];

// The newest few live candles per market are enough: anything older is in the history.
const LIVE_KEPT = 60;

type CandleStore = {
  live: Record<string, Candle[]>;
  receive: (message: CandleMessage) => void;
};

export const useCandles = create<CandleStore>((set) => ({
  live: {},
  receive({ market, start, open, high, low, close, volume, trades }) {
    const candle = { start, open, high, low, close, volume, trades };
    set((state) => ({
      live: {
        ...state.live,
        [market]: mergeCandles(state.live[market] ?? NO_CANDLES, [candle], LIVE_KEPT),
      },
    }));
  },
}));

export const liveCandles = (market: string) => (state: CandleStore) =>
  state.live[market] ?? NO_CANDLES;
