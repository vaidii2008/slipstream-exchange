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
import type { Side } from "./book.ts";
import { type Exchange, type MarketUpdate, SerialQueue } from "./exchange.ts";
import type { Database } from "./ledger.ts";
import { formatAmount } from "./money.ts";
import { loadMarket, type Market } from "./orders.ts";

export type WebSocketDependencies = {
  db: Database;
  exchange: Exchange;
};

// A client message larger than this closes the connection: commands are tiny.
const MAX_CLIENT_MESSAGE_BYTES = 4096;

const marketChannel = {
  channel: z.enum(["book", "trades"]),
  market: z.string().min(1).max(32),
};
const clientMessage = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("subscribe"), ...marketChannel }),
  z.strictObject({ op: z.literal("unsubscribe"), ...marketChannel }),
]);
type ClientMessage = z.infer<typeof clientMessage>;

type Level = { price: string; quantity: string };

export type ServerMessage =
  | { type: "subscribed" | "unsubscribed"; channel: string; market: string }
  | { type: "error"; error: string; message: string }
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

const topicOf = (channel: string, market: string) => `${channel}:${market}`;

// One client. Its messages are handled one at a time, in arrival order, so "subscribe then
// unsubscribe" can never end subscribed because the first was slower.
class Connection {
  readonly socket: WebSocket;
  readonly topics = new Set<string>();
  readonly inbox = new SerialQueue();

  constructor(socket: WebSocket) {
    this.socket = socket;
  }

  send(message: ServerMessage): void {
    this.socket.send(JSON.stringify(message));
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

  publish(topic: string, message: ServerMessage): void {
    const connections = this.#byTopic.get(topic);
    if (connections === undefined) {
      return;
    }
    // Serialised once, however many subscribers there are.
    const text = JSON.stringify(message);
    for (const connection of connections) {
      connection.socket.send(text);
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

export function registerWebSocketRoutes(
  app: FastifyInstance,
  { db, exchange }: WebSocketDependencies,
) {
  const hub = new MarketDataHub();

  const stopListening = exchange.onUpdate((update) => {
    hub.publish(topicOf("book", update.market.symbol), bookUpdate(update));
    for (const trade of tradeMessages(update)) {
      hub.publish(topicOf("trades", update.market.symbol), trade);
    }
  });
  app.addHook("onClose", (_instance, done) => {
    stopListening();
    done();
  });

  async function handle(connection: Connection, data: RawData): Promise<void> {
    const message = parse(data);
    if ("type" in message) {
      connection.send(message);
      return;
    }

    const { channel } = message;
    const market = await loadMarket(db, message.market);
    if (market === undefined) {
      connection.send({
        type: "error",
        error: "unknown_market",
        message: `${message.market} is not a listed market`,
      });
      return;
    }

    const topic = topicOf(channel, market.symbol);
    if (message.op === "subscribe") {
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
    const connection = new Connection(socket);
    socket.on("message", (data) => {
      void connection.inbox
        .run(() => handle(connection, data))
        .catch((error: unknown) => {
          log.error({ err: error }, "websocket message failed");
          connection.send({ type: "error", error: "internal_error", message: "try again" });
        });
    });
    socket.on("close", () => {
      hub.disconnect(connection);
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
