// Real-time data over one WebSocket at /ws. A client sends small JSON commands (subscribe,
// unsubscribe) and the server answers each one and then streams what the client subscribed
// to. Every client message is validated with zod; a bad one gets an error message and the
// connection stays open.
//
// The book channel is a snapshot followed by deltas. The snapshot carries the sequence it is
// current as of; each delta carries the first and last sequence of the command it describes.
// A client drops any delta whose `sequence` is at or below what it already has, and treats a
// `firstSequence` other than its last sequence + 1 as a gap: it has missed something, and
// subscribes again to get a fresh snapshot.
//
// Public channels never carry a user id or an order id. Engine events have both, so every
// message is built field by field here rather than passed through.

import websocket from "@fastify/websocket";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import type { RawData, WebSocket } from "ws";
import { z } from "zod";
import { type Exchange, SerialQueue } from "./exchange.ts";
import type { FeedChannels, MarketFeedMessage, ServerMessage } from "./feed.ts";
import { accountState, type Database } from "./ledger.ts";
import { formatAmount } from "./money.ts";
import { loadMarket, type Market } from "./orders.ts";
import type { RedisClient } from "./redis.ts";
import type { AccessTokens } from "./tokens.ts";

export type WebSocketDependencies = {
  db: Database;
  exchange: Exchange;
  tokens: AccessTokens;
  // A connection used only for SUBSCRIBE: Redis allows nothing else on it.
  subscriber: RedisClient;
  channels: FeedChannels;
  limits: WebSocketLimits;
};

// A client message larger than this closes the connection: commands are tiny.
const MAX_CLIENT_MESSAGE_BYTES = 4096;

// book and trades are per market and public; account is the authenticated user's own.
const channelFields = {
  channel: z.enum(["book", "trades", "account"]),
  market: z.string().min(1).max(32).optional(),
};
const marketMatchesChannel = (message: { channel: string; market?: string | undefined }) =>
  (message.channel === "account") === (message.market === undefined);
const MARKET_RULE = {
  message: "market is required for book and trades, and not allowed for account",
  path: ["market"],
};
const clientMessage = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("auth"), token: z.string().min(1).max(4096) }),
  z
    .strictObject({ op: z.literal("subscribe"), ...channelFields })
    .refine(marketMatchesChannel, MARKET_RULE),
  z
    .strictObject({ op: z.literal("unsubscribe"), ...channelFields })
    .refine(marketMatchesChannel, MARKET_RULE),
]);
type ClientMessage = z.infer<typeof clientMessage>;

// Every level, best first. The book is in memory and bounded by what users rest, so a full
// snapshot keeps deltas simple: a client never has to fetch a level it was not sent.
const WHOLE_BOOK = Number.MAX_SAFE_INTEGER;

function bookSnapshot(exchange: Exchange, market: Market): ServerMessage {
  const { sequence, bids, asks } = exchange.depth(market.symbol, WHOLE_BOOK);
  const level = ({ price, quantity }: { price: bigint; quantity: bigint }) => ({
    price: formatAmount(price, market.quoteScale),
    quantity: formatAmount(quantity, market.baseScale),
  });
  return {
    type: "book",
    market: market.symbol,
    sequence,
    bids: bids.map(level),
    asks: asks.map(level),
  };
}

const topicOf = (channel: string, market: string) => `${channel}:${market}`;

// One client. Its messages are handled one at a time, in arrival order, so "subscribe then
// unsubscribe" can never end subscribed because the first was slower.
export type WebSocketLimits = {
  // How often each connection is pinged. One that has not answered the previous ping by the
  // next one is gone (a dead network path never sends a close) and is terminated.
  heartbeatMs: number;
  // Bytes a connection may have queued and unsent. A client that reads slower than the
  // market moves would otherwise make the server buffer for it without limit.
  maxBufferedBytes: number;
};

export const DEFAULT_WEBSOCKET_LIMITS: WebSocketLimits = {
  heartbeatMs: 15_000,
  maxBufferedBytes: 1024 * 1024,
};

class Connection {
  readonly socket: WebSocket;
  readonly topics = new Set<string>();
  readonly inbox = new SerialQueue();
  readonly #maxBufferedBytes: number;
  userId: string | undefined;
  // Closes the connection when its access token expires.
  expiry: NodeJS.Timeout | undefined;
  // Cleared on each ping, set again by the pong.
  alive = true;

  constructor(socket: WebSocket, maxBufferedBytes: number) {
    this.socket = socket;
    this.#maxBufferedBytes = maxBufferedBytes;
  }

  send(message: ServerMessage): void {
    this.sendText(JSON.stringify(message));
  }

  // Terminated rather than closed: a close frame would queue behind the backlog it is
  // meant to stop. The client sees an abnormal close, reconnects and resyncs.
  sendText(text: string): void {
    if (this.socket.bufferedAmount > this.#maxBufferedBytes) {
      this.socket.terminate();
      return;
    }
    this.socket.send(text);
  }
}

// Who is subscribed to what, by topic ("book:BTC-USD").
export class MarketDataHub {
  readonly #byTopic = new Map<string, Set<Connection>>();

  subscribe(connection: Connection, topic: string): void {
    let connections = this.#byTopic.get(topic);
    if (connections === undefined) {
      connections = new Set();
      this.#byTopic.set(topic, connections);
    }
    connections.add(connection);
    connection.topics.add(topic);
  }

  unsubscribe(connection: Connection, topic: string): void {
    const connections = this.#byTopic.get(topic);
    connections?.delete(connection);
    if (connections?.size === 0) {
      this.#byTopic.delete(topic);
    }
    connection.topics.delete(topic);
  }

  has(topic: string): boolean {
    return this.#byTopic.has(topic);
  }

  publish(topic: string, message: ServerMessage): void {
    const connections = this.#byTopic.get(topic);
    if (connections === undefined) {
      return;
    }
    // Serialised once, however many subscribers there are.
    const text = JSON.stringify(message);
    for (const connection of connections) {
      connection.sendText(text);
    }
  }

  disconnect(connection: Connection): void {
    for (const topic of [...connection.topics]) {
      this.unsubscribe(connection, topic);
    }
  }
}

// A frame arrives as one Buffer, an ArrayBuffer, or several Buffers if it was fragmented.
export function decode(data: RawData): string {
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  return data instanceof ArrayBuffer ? Buffer.from(data).toString("utf8") : data.toString("utf8");
}

function parse(data: RawData): ClientMessage | ServerMessage {
  let json: unknown;
  try {
    json = JSON.parse(decode(data));
  } catch {
    return { type: "error", error: "invalid_message", message: "not valid JSON" };
  }
  const parsed = clientMessage.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue === undefined || issue.path.length === 0 ? "" : `${issue.path.join(".")}: `;
    return { type: "error", error: "invalid_message", message: `${where}${issue?.message ?? ""}` };
  }
  return parsed.data;
}

// A token's user stays authenticated until the token expires; the connection is then closed
// with this code, and the client reconnects with a fresh token.
export const TOKEN_EXPIRED_CLOSE_CODE = 4001;

async function balancesMessage(db: Database, userId: string): Promise<ServerMessage> {
  const { version, balances } = await accountState(db, userId);
  return {
    type: "balances",
    version,
    balances: balances.map((balance) => ({
      asset: balance.asset,
      available: formatAmount(balance.available, balance.scale),
      reserved: formatAmount(balance.reserved, balance.scale),
    })),
  };
}

export function registerWebSocketRoutes(
  app: FastifyInstance,
  { db, exchange, tokens, subscriber, channels, limits }: WebSocketDependencies,
) {
  const hub = new MarketDataHub();
  const connections = new Set<Connection>();

  let heartbeat: NodeJS.Timeout | undefined;
  app.addHook("onReady", (done) => {
    heartbeat = setInterval(() => {
      for (const connection of connections) {
        if (!connection.alive) {
          connection.socket.terminate();
          continue;
        }
        connection.alive = false;
        connection.socket.ping();
      }
    }, limits.heartbeatMs);
    done();
  });
  app.addHook("onClose", (_instance, done) => {
    clearInterval(heartbeat);
    done();
  });

  // Read after the settlement committed, so it includes it. Off the market's queue: the
  // listener must not wait, and only users with a connection pay for the read.
  function sendBalances(userId: string): void {
    balancesMessage(db, userId).then(
      (message) => {
        hub.publish(topicOf("account", userId), message);
      },
      (error: unknown) => {
        app.log.error({ err: error, userId }, "balances for the account channel failed");
      },
    );
  }

  // Messages on the feed come only from publishUpdate in this codebase, so they are parsed,
  // not validated.
  function onMarketMessage(text: string): void {
    const { book, trades } = JSON.parse(text) as MarketFeedMessage;
    if (book.type === "book_update") {
      hub.publish(topicOf("book", book.market), book);
    }
    for (const trade of trades) {
      if (trade.type === "trade") {
        hub.publish(topicOf("trades", trade.market), trade);
      }
    }
  }

  app.addHook("onReady", async () => {
    await subscriber.pSubscribe(channels.marketPattern, onMarketMessage);
  });
  app.addHook("onClose", async () => {
    if (subscriber.isReady) {
      await subscriber.pUnsubscribe(channels.marketPattern, onMarketMessage);
    }
  });

  // A user's channel is subscribed while at least one of their connections here is on the
  // account channel. One listener per user, so the last one out can remove exactly it.
  const userListeners = new Map<string, (text: string) => void>();

  async function watchUser(userId: string): Promise<void> {
    if (userListeners.has(userId)) {
      return;
    }
    const listener = (text: string) => {
      hub.publish(topicOf("account", userId), JSON.parse(text) as ServerMessage);
      sendBalances(userId);
    };
    userListeners.set(userId, listener);
    try {
      await subscriber.subscribe(channels.user(userId), listener);
    } catch (error) {
      userListeners.delete(userId);
      throw error;
    }
  }

  function unwatchUserIfIdle(userId: string): void {
    const listener = userListeners.get(userId);
    if (listener === undefined || hub.has(topicOf("account", userId))) {
      return;
    }
    userListeners.delete(userId);
    subscriber.unsubscribe(channels.user(userId), listener).catch((error: unknown) => {
      app.log.warn({ err: error, userId }, "unsubscribing a user channel failed");
    });
  }

  async function authenticate(connection: Connection, token: string): Promise<void> {
    const verification = await tokens.verify(token);
    if (!verification.ok) {
      const error = verification.reason === "expired" ? "token_expired" : "invalid_token";
      connection.send({ type: "error", error, message: "authenticate with a valid access token" });
      return;
    }
    // One user per connection: switching would leave the old user's account subscription.
    if (connection.userId !== undefined && connection.userId !== verification.userId) {
      connection.send({
        type: "error",
        error: "already_authenticated",
        message: "this connection belongs to another user; open a new one",
      });
      return;
    }
    connection.userId = verification.userId;
    clearTimeout(connection.expiry);
    connection.expiry = setTimeout(
      () => {
        connection.socket.close(TOKEN_EXPIRED_CLOSE_CODE, "access token expired");
      },
      Math.max(0, verification.expiresAt.getTime() - Date.now()),
    );
    connection.send({ type: "authenticated", expiresAt: verification.expiresAt.toISOString() });
  }

  async function handle(connection: Connection, data: RawData): Promise<void> {
    const message = parse(data);
    if ("type" in message) {
      connection.send(message);
      return;
    }
    if (message.op === "auth") {
      await authenticate(connection, message.token);
      return;
    }

    const { op, channel } = message;
    if (channel === "account") {
      if (connection.userId === undefined) {
        connection.send({
          type: "error",
          error: "unauthenticated",
          message: "send an auth message before subscribing to account",
        });
        return;
      }
      const topic = topicOf("account", connection.userId);
      if (op === "subscribe") {
        await watchUser(connection.userId);
        hub.subscribe(connection, topic);
        connection.send({ type: "subscribed", channel });
        connection.send(await balancesMessage(db, connection.userId));
      } else {
        hub.unsubscribe(connection, topic);
        unwatchUserIfIdle(connection.userId);
        connection.send({ type: "unsubscribed", channel });
      }
      return;
    }

    const market = await loadMarket(db, message.market ?? "");
    if (market === undefined) {
      connection.send({
        type: "error",
        error: "unknown_market",
        message: `${message.market ?? ""} is not a listed market`,
      });
      return;
    }

    const topic = topicOf(channel, market.symbol);
    if (op === "subscribe") {
      hub.subscribe(connection, topic);
      connection.send({ type: "subscribed", channel, market: market.symbol });
      // Taken after subscribing and in the same tick, so no delta can fall between the two.
      // Subscribing again while subscribed re-sends it: that is how a client resyncs.
      if (channel === "book") {
        connection.send(bookSnapshot(exchange, market));
      }
    } else {
      hub.unsubscribe(connection, topic);
      connection.send({ type: "unsubscribed", channel, market: market.symbol });
    }
  }

  function accept(socket: WebSocket, log: FastifyBaseLogger): void {
    const connection = new Connection(socket, limits.maxBufferedBytes);
    connections.add(connection);
    socket.on("pong", () => {
      connection.alive = true;
    });
    socket.on("message", (data) => {
      void connection.inbox
        .run(() => handle(connection, data))
        .catch((error: unknown) => {
          log.error({ err: error }, "websocket message failed");
          connection.send({ type: "error", error: "internal_error", message: "try again" });
        });
    });
    socket.on("close", () => {
      connections.delete(connection);
      clearTimeout(connection.expiry);
      hub.disconnect(connection);
      if (connection.userId !== undefined) {
        unwatchUserIfIdle(connection.userId);
      }
    });
  }

  void app.register(websocket, { options: { maxPayload: MAX_CLIENT_MESSAGE_BYTES } });
  // Registered as its own plugin so it loads after @fastify/websocket, which has to see the
  // route to upgrade it.
  void app.register((scope, _options, done) => {
    scope.get("/ws", { websocket: true }, (socket, request) => {
      accept(socket, request.log);
    });
    done();
  });
}
