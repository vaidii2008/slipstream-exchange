// Recent trades: a page of history from REST, then every new one from the trades channel.
//
// The two overlap. The socket subscribes before or while the history loads, so a trade
// settled in between can arrive both ways. Both carry the engine's sequence, so the merge
// keeps one copy of each. After a reconnect the live list is cleared and the history
// fetched again, which covers whatever settled while the socket was down.

import { create } from "zustand";
import type { ServerMessage, Side } from "@slipstream/protocol";

export type Trade = {
  sequence: number;
  price: string;
  quantity: string;
  takerSide: Side;
  time: string;
};

export const TRADES_SHOWN = 50;

// Newest first, one per sequence, at most `limit`.
export function mergeTrades(history: Trade[], live: Trade[], limit = TRADES_SHOWN): Trade[] {
  const seen = new Set(history.map((trade) => trade.sequence));
  const fresh = live.filter((trade) => !seen.has(trade.sequence));
  return [...fresh, ...history].slice(0, limit);
}

type TradeMessage = Extract<ServerMessage, { type: "trade" }>;

const NO_TRADES: Trade[] = [];

type TradeStore = {
  live: Record<string, Trade[]>;
  receive: (message: TradeMessage) => void;
  clearAll: () => void;
};

export const useTrades = create<TradeStore>((set) => ({
  live: {},
  receive({ market, sequence, price, quantity, takerSide, time }) {
    set((state) => ({
      live: {
        ...state.live,
        [market]: [
          { sequence, price, quantity, takerSide, time },
          ...(state.live[market] ?? NO_TRADES),
        ].slice(0, TRADES_SHOWN),
      },
    }));
  },
  clearAll() {
    set({ live: {} });
  },
}));

export const liveTrades = (market: string) => (state: TradeStore) =>
  state.live[market] ?? NO_TRADES;
