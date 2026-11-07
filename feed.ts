// The market data feed: what one settled command becomes on the wire, and carrying it to
// every API process through Redis pub/sub. Public messages carry prices, quantities and
// sequences only; an engine event's user ids and order ids stop here. Private order messages
// go only to their owner's channel.
//
// Publishing is fire and forget. A publish that fails, for example during a Redis outage, is
// logged and dropped rather than retried or queued: the book channel's sequence numbers show
// subscribers the gap, and they resync from a fresh snapshot.

import type { FastifyBaseLogger } from "fastify";
import { formatCandle, type LiveCandles } from "./candles.ts";
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

// The candle in progress after this command, or nothing if the command did not trade.
export function candleMessages(candles: LiveCandles, update: MarketUpdate): ServerMessage[] {
  const { market, events, settledAt } = update;
  const candle = candles.add(
    market.symbol,
    events.flatMap((event) =>
      event.type === "trade"
        ? [{ price: event.price, quantity: event.quantity, time: settledAt }]
        : [],
    ),
  );
  return candle === undefined
    ? []
    : [{ type: "candle", market: market.symbol, ...formatCandle(market, candle) }];
}

// What travels on a market's channel: everything one command did, public only. Candles
// travel as whole candles, not trades to fold, so a process that missed a message is wrong
// only until the next one.
export type MarketFeedMessage = {
  book: ServerMessage;
  trades: ServerMessage[];
  candles: ServerMessage[];
};

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

// What travels on a user's channel: their order messages, which go to their sockets as they
// are, and a notice that a deposit landed, which does not. Either makes the gateway re-read
// the user's balances, so a deposit reaches the account channel the way order activity does.
export type UserFeedMessage = ServerMessage | { type: "deposited" };

// Fire and forget, like every publish here: a dropped one is logged, and the next balances
// message, or a reload, shows the deposit.
function publish(
  redis: RedisClient,
  channel: string,
  message: MarketFeedMessage | UserFeedMessage,
  log: FastifyBaseLogger,
): void {
  redis.publish(channel, JSON.stringify(message)).catch((error: unknown) => {
    log.warn({ err: error, channel }, "market data publish dropped");
  });
}

export function publishDeposit(
  redis: RedisClient,
  channels: FeedChannels,
  userId: string,
  log: FastifyBaseLogger,
): void {
  publish(redis, channels.user(userId), { type: "deposited" }, log);
}

export function publishUpdate(
  redis: RedisClient,
  channels: FeedChannels,
  candles: LiveCandles,
  update: MarketUpdate,
  log: FastifyBaseLogger,
): void {
  const { market } = update;
  const message: MarketFeedMessage = {
    book: bookUpdate(update),
    trades: tradeMessages(update),
    candles: candleMessages(candles, update),
  };
  publish(redis, channels.market(market.symbol), message, log);
  for (const order of update.orders) {
    publish(redis, channels.user(order.userId), orderMessage(market, order), log);
  }
}
