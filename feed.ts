// The market data feed: what one settled command becomes on the wire, and carrying it to
// every API process through Redis pub/sub. Public messages carry prices, quantities and
// sequences only; an engine event's user ids and order ids stop here. Private order messages
// go only to their owner's channel.
//
// Publishing is fire and forget. A publish that fails, for example during a Redis outage, is
// logged and dropped rather than retried or queued: the book channel's sequence numbers show
// subscribers the gap, and they resync from a fresh snapshot.

import type { FastifyBaseLogger } from "fastify";
import type { MarketUpdate } from "./exchange.ts";
import { formatAmount } from "./money.ts";
import type { Market } from "./orders.ts";
import type { ServerMessage } from "./protocol.ts";
import type { RedisClient } from "./redis.ts";
import type { SettledOrder } from "./settlement.ts";

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

// What travels on a market's channel: everything one command did, public only.
export type MarketFeedMessage = { book: ServerMessage; trades: ServerMessage[] };

// Channel names under one prefix, so separate deployments (or test servers) sharing a Redis
// never hear each other.
export function feedChannels(prefix: string) {
  return {
    market: (symbol: string) => `${prefix}market:${symbol}`,
    marketPattern: `${prefix}market:*`,
    user: (userId: string) => `${prefix}user:${userId}`,
  };
}

export type FeedChannels = ReturnType<typeof feedChannels>;

export function publishUpdate(
  redis: RedisClient,
  channels: FeedChannels,
  update: MarketUpdate,
  log: FastifyBaseLogger,
): void {
  const send = (channel: string, message: unknown) => {
    redis.publish(channel, JSON.stringify(message)).catch((error: unknown) => {
      log.warn({ err: error, channel }, "market data publish dropped");
    });
  };
  const { market } = update;
  const message: MarketFeedMessage = { book: bookUpdate(update), trades: tradeMessages(update) };
  send(channels.market(market.symbol), message);
  for (const order of update.orders) {
    send(channels.user(order.userId), orderMessage(market, order));
  }
}
