// The market data feed: what one settled command becomes on the wire. Public messages carry
// prices, quantities and sequences only; an engine event's user ids and order ids stop here.
// Private order messages go only to their owner.

import type { Side } from "./book.ts";
import type { MarketUpdate } from "./exchange.ts";
import { formatAmount } from "./money.ts";
import type { Market } from "./orders.ts";
import type { SettledOrder } from "./settlement.ts";

type Level = { price: string; quantity: string };

export type ServerMessage =
  | { type: "subscribed" | "unsubscribed"; channel: string; market?: string }
  | { type: "authenticated"; expiresAt: string }
  | { type: "error"; error: string; message: string }
  | {
      type: "order";
      market: string;
      id: string;
      clientOrderId: string | null;
      status: string;
      filledQuantity: string;
      sequence: number;
    }
  | {
      // The whole balance sheet. Keep the one with the highest version: two markets can
      // settle for the same user at once, and their balance reads can arrive out of order.
      type: "balances";
      version: number;
      balances: { asset: string; available: string; reserved: string }[];
    }
  | { type: "book"; market: string; sequence: number; bids: Level[]; asks: Level[] }
  | {
      type: "book_update";
      market: string;
      firstSequence: number;
      sequence: number;
      // The new total at each level the command changed; "0" removes the level.
      changes: (Level & { side: Side })[];
    }
  | {
      type: "trade";
      market: string;
      sequence: number;
      price: string;
      quantity: string;
      takerSide: Side;
      time: string;
    };

// One message per trade, in sequence order. Trades are not every sequence number, so this
// channel cannot show a gap; the book channel is where a client checks continuity.
export function tradeMessages({ market, events, settledAt }: MarketUpdate): ServerMessage[] {
  return events.flatMap((event) =>
    event.type === "trade"
      ? [
          {
            type: "trade" as const,
            market: market.symbol,
            sequence: event.sequence,
            price: formatAmount(event.price, market.quoteScale),
            quantity: formatAmount(event.quantity, market.baseScale),
            takerSide: event.takerSide,
            time: settledAt.toISOString(),
          },
        ]
      : [],
  );
}

export function bookUpdate({
  market,
  firstSequence,
  sequence,
  levels,
}: MarketUpdate): ServerMessage {
  return {
    type: "book_update",
    market: market.symbol,
    firstSequence,
    sequence,
    changes: levels.map(({ side, price, quantity }) => ({
      side,
      price: formatAmount(price, market.quoteScale),
      quantity: formatAmount(quantity, market.baseScale),
    })),
  };
}

export function orderMessage(market: Market, order: SettledOrder): ServerMessage {
  return {
    type: "order",
    market: market.symbol,
    id: order.id,
    clientOrderId: order.clientOrderId,
    status: order.status,
    filledQuantity: formatAmount(order.filledQuantity, market.baseScale),
    sequence: order.sequence,
  };
}
