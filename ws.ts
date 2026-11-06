// Real-time data over one WebSocket at /ws. A client sends small JSON commands (subscribe,
// unsubscribe) and the server answers each one and then streams what the client subscribed
// to. Every client message is validated with zod; a bad one gets an error message and the
// connection stays open.

import websocket from "@fastify/websocket";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import type { RawData, WebSocket } from "ws";
import { z } from "zod";
import { SerialQueue } from "./exchange.ts";
import type { Database } from "./ledger.ts";
import { loadMarket } from "./orders.ts";

export type WebSocketDependencies = {
  db: Database;
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

export type ServerMessage =
  | { type: "subscribed" | "unsubscribed"; channel: string; market: string }
  | { type: "error"; error: string; message: string };

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

export function registerWebSocketRoutes(app: FastifyInstance, { db }: WebSocketDependencies) {
  const hub = new MarketDataHub();

  async function handle(connection: Connection, data: RawData): Promise<void> {
    const message = parse(data);
    if ("type" in message) {
      connection.send(message);
      return;
    }

    const { channel, market } = message;
    if ((await loadMarket(db, market)) === undefined) {
      connection.send({
        type: "error",
        error: "unknown_market",
        message: `${market} is not a listed market`,
      });
      return;
    }

    const topic = topicOf(channel, market);
    if (message.op === "subscribe") {
      hub.subscribe(connection, topic);
      connection.send({ type: "subscribed", channel, market });
    } else {
      hub.unsubscribe(connection, topic);
      connection.send({ type: "unsubscribed", channel, market });
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
