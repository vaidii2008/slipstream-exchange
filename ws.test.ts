import { setTimeout as delay } from "node:timers/promises";
import { afterAll, describe, expect, it } from "vitest";
import type { WebSocket } from "ws";
import { Exchange } from "./exchange.ts";
import { deposit } from "./ledger.ts";
import { parseAmount } from "./money.ts";
import { loadMarket, type Market } from "./orders.ts";
import { users } from "./schema.ts";
import { buildServer, type ServerOptions } from "./server.ts";
import { createRedisClient } from "./redis.ts";
import { redisProxy, TEST_SECRET, uniqueMarketDataPrefix, useTestServer } from "./testing.ts";
import { createAccessTokens } from "./tokens.ts";
import { decode, TOKEN_EXPIRED_CLOSE_CODE } from "./ws.ts";

const { app, pool, redis, subscriber, db, tokens, uniqueEmail } = useTestServer();

const units = (value: string): bigint => {
  const parsed = parseAmount(value, 8);
  if (!parsed.ok) {
    throw new Error(`bad test amount ${value}: ${parsed.reason}`);
  }
  return parsed.units;
};

async function funded(holdings: Record<string, string>): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({ email: uniqueEmail("ws-test"), passwordHash: "not-a-real-hash" })
    .returning({ id: users.id });
  if (user === undefined) {
    throw new Error("user insert returned no row");
  }
  for (const [asset, amount] of Object.entries(holdings)) {
    await deposit(db, user.id, asset, units(amount));
  }
  return user.id;
}

// A server around a fresh exchange, so its sequences start at 1 and its book is empty.
function freshServer(options: ServerOptions = {}) {
  const exchange = new Exchange(db);
  const server = buildServer(
    { pool, redis, subscriber, db, tokens, exchange },
    { marketDataPrefix: uniqueMarketDataPrefix(), ...options },
  );
  afterAll(async () => {
    await server.close();
  });
  return { exchange, server };
}

async function btcUsd(): Promise<Market> {
  const market = await loadMarket(db, "BTC-USD");
  if (market === undefined) {
    throw new Error("BTC-USD is not seeded");
  }
  return market;
}

const limit = (userId: string, side: "buy" | "sell", price: string, quantity: string) => ({
  type: "limit" as const,
  userId,
  side,
  price: units(price),
  quantity: units(quantity),
});

type Server = typeof app;

// A test client: queues what the server sends so a test can await messages in order, and
// fails instead of hanging when an expected message never comes.
async function connect(server: Server = app) {
  await server.ready();
  const socket: WebSocket = await server.injectWS("/ws");
  const inbox: unknown[] = [];
  const waiting: ((message: unknown) => void)[] = [];
  socket.on("message", (data) => {
    const message: unknown = JSON.parse(decode(data));
    const waiter = waiting.shift();
    if (waiter === undefined) {
      inbox.push(message);
    } else {
      waiter(message);
    }
  });

  return {
    socket,
    send(message: unknown) {
      socket.send(typeof message === "string" ? message : JSON.stringify(message));
    },
    next(): Promise<unknown> {
      if (inbox.length > 0) {
        return Promise.resolve(inbox.shift());
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error("no message from the server within 2 s"));
        }, 2000);
        waiting.push((message) => {
          clearTimeout(timer);
          resolve(message);
        });
      });
    },
    close() {
      socket.terminate();
    },
    closed(): Promise<number> {
      return new Promise((resolve) => {
        socket.on("close", (code) => {
          resolve(code);
        });
      });
    },
  };
}

describe("the /ws subscribe protocol", () => {
  it("confirms a subscription and an unsubscription", async () => {
    const client = await connect();

    client.send({ op: "subscribe", channel: "book", market: "BTC-USD" });
    await expect(client.next()).resolves.toEqual({
      type: "subscribed",
      channel: "book",
      market: "BTC-USD",
    });
    await expect(client.next()).resolves.toMatchObject({ type: "book", market: "BTC-USD" });
    client.send({ op: "unsubscribe", channel: "book", market: "BTC-USD" });
    await expect(client.next()).resolves.toEqual({
      type: "unsubscribed",
      channel: "book",
      market: "BTC-USD",
    });
    client.close();
  });

  it.each([
    ["not JSON", "{subscribe", "not valid JSON"],
    ["an unknown op", { op: "trade", channel: "book", market: "BTC-USD" }, "op: "],
    ["an unknown channel", { op: "subscribe", channel: "candles", market: "BTC-USD" }, "channel"],
    ["an extra field", { op: "subscribe", channel: "book", market: "BTC-USD", depth: 5 }, ""],
    ["a book with no market", { op: "subscribe", channel: "book" }, "market"],
    [
      "an account with a market",
      { op: "subscribe", channel: "account", market: "BTC-USD" },
      "market",
    ],
  ])("answers %s with invalid_message and stays open", async (_label, message, detail) => {
    const client = await connect();

    client.send(message);
    const error = await client.next();
    client.send({ op: "subscribe", channel: "trades", market: "ETH-USD" });

    expect(error).toMatchObject({
      type: "error",
      error: "invalid_message",
      message: expect.stringContaining(detail) as unknown,
    });
    await expect(client.next()).resolves.toMatchObject({ type: "subscribed" });
    client.close();
  });

  it("refuses a market that is not listed", async () => {
    const client = await connect();

    client.send({ op: "subscribe", channel: "book", market: "DOGE-USD" });

    await expect(client.next()).resolves.toEqual({
      type: "error",
      error: "unknown_market",
      message: "DOGE-USD is not a listed market",
    });
    client.close();
  });

  it("answers messages in the order they were sent", async () => {
    const client = await connect();

    client.send({ op: "subscribe", channel: "trades", market: "BTC-USD" });
    client.send({ op: "unsubscribe", channel: "trades", market: "BTC-USD" });
    client.send({ op: "subscribe", channel: "trades", market: "ETH-USD" });

    const replies = [await client.next(), await client.next(), await client.next()];
    expect(replies.map((reply) => (reply as { type: string }).type)).toEqual([
      "subscribed",
      "unsubscribed",
      "subscribed",
    ]);
    client.close();
  });

  it("closes the connection on a message over 4 KB", async () => {
    const client = await connect();
    const closed = new Promise<number>((resolve) => {
      client.socket.on("close", (code) => {
        resolve(code);
      });
    });

    client.send("x".repeat(5000));

    await expect(closed).resolves.toBe(1009);
  });
});

describe("the book channel", () => {
  const { exchange, server } = freshServer();

  it("sends a snapshot, then one delta per command with the new total at each level", async () => {
    const market = await btcUsd();
    const seller = await funded({ BTC: "1" });
    const buyer = await funded({ USD: "100000" });
    const client = await connect(server);
    client.send({ op: "subscribe", channel: "book", market: "BTC-USD" });
    await client.next();

    await expect(client.next()).resolves.toEqual({
      type: "book",
      market: "BTC-USD",
      sequence: 0,
      bids: [],
      asks: [],
    });

    const ask = await exchange.placeOrder(market, limit(seller, "sell", "60000", "0.1"));
    await expect(client.next()).resolves.toEqual({
      type: "book_update",
      market: "BTC-USD",
      firstSequence: 1,
      sequence: 1,
      changes: [{ side: "sell", price: "60000.00000000", quantity: "0.10000000" }],
    });

    // A partial fill: one trade event, the ask level shrinks.
    await exchange.placeOrder(market, limit(buyer, "buy", "60000", "0.04"));
    await expect(client.next()).resolves.toMatchObject({
      firstSequence: 2,
      sequence: 2,
      changes: [{ side: "sell", price: "60000.00000000", quantity: "0.06000000" }],
    });

    // Takes the rest and rests 0.04: two events, the ask level goes, a bid level appears.
    const bid = await exchange.placeOrder(market, limit(buyer, "buy", "60000", "0.1"));
    const update = await client.next();
    expect(update).toMatchObject({
      firstSequence: 3,
      sequence: 4,
      changes: [
        { side: "sell", price: "60000.00000000", quantity: "0.00000000" },
        { side: "buy", price: "60000.00000000", quantity: "0.04000000" },
      ],
    });

    // A late subscriber's snapshot matches the book the deltas built.
    const late = await connect(server);
    late.send({ op: "subscribe", channel: "book", market: "BTC-USD" });
    await late.next();
    await expect(late.next()).resolves.toEqual({
      type: "book",
      market: "BTC-USD",
      sequence: 4,
      bids: [{ price: "60000.00000000", quantity: "0.04000000" }],
      asks: [],
    });

    const sent = JSON.stringify(update);
    for (const id of [seller, buyer, ask.id, bid.id]) {
      expect(sent).not.toContain(id);
    }
    client.close();
    late.close();
  });

  it("stops sending deltas after an unsubscribe", async () => {
    const market = await btcUsd();
    const seller = await funded({ BTC: "1" });
    const client = await connect(server);
    client.send({ op: "subscribe", channel: "book", market: "BTC-USD" });
    await client.next();
    await client.next();
    client.send({ op: "unsubscribe", channel: "book", market: "BTC-USD" });
    await client.next();

    await exchange.placeOrder(market, limit(seller, "sell", "70000", "0.1"));
    client.send({ op: "subscribe", channel: "trades", market: "BTC-USD" });

    // The next thing to arrive is the reply, not a delta for the order.
    await expect(client.next()).resolves.toMatchObject({ type: "subscribed", channel: "trades" });
    client.close();
  });
});

describe("the trades channel", () => {
  const { exchange, server } = freshServer();

  it("sends each trade with its sequence and the taker's side, naming no user or order", async () => {
    const market = await btcUsd();
    const buyer = await funded({ USD: "100000" });
    const seller = await funded({ BTC: "1" });
    const client = await connect(server);
    client.send({ op: "subscribe", channel: "trades", market: "BTC-USD" });
    await client.next();

    const bids = [
      await exchange.placeOrder(market, limit(buyer, "buy", "60100", "0.1")),
      await exchange.placeOrder(market, limit(buyer, "buy", "60000", "0.1")),
    ];
    // One sell sweeps both bids: two trades, best price first.
    const sell = await exchange.placeOrder(market, limit(seller, "sell", "60000", "0.15"));

    const trades = [await client.next(), await client.next()];
    expect(trades).toEqual([
      {
        type: "trade",
        market: "BTC-USD",
        sequence: 3,
        price: "60100.00000000",
        quantity: "0.10000000",
        takerSide: "sell",
        time: expect.stringMatching(/^\d{4}-\d\d-\d\dT/) as unknown,
      },
      expect.objectContaining({ sequence: 4, price: "60000.00000000", quantity: "0.05000000" }),
    ]);
    const sent = JSON.stringify(trades);
    for (const id of [buyer, seller, sell.id, ...bids.map((bid) => bid.id)]) {
      expect(sent).not.toContain(id);
    }
    client.close();
  });
});

describe("the account channel", () => {
  const { exchange, server } = freshServer();

  async function signedIn(userId: string) {
    const client = await connect(server);
    client.send({ op: "auth", token: await tokens.issue(userId) });
    await expect(client.next()).resolves.toMatchObject({ type: "authenticated" });
    client.send({ op: "subscribe", channel: "account" });
    await expect(client.next()).resolves.toEqual({ type: "subscribed", channel: "account" });
    return client;
  }

  it("refuses to subscribe before authenticating, and refuses a bad token", async () => {
    const client = await connect(server);

    client.send({ op: "subscribe", channel: "account" });
    await expect(client.next()).resolves.toMatchObject({ error: "unauthenticated" });
    client.send({ op: "auth", token: "not-a-jwt" });
    await expect(client.next()).resolves.toMatchObject({ error: "invalid_token" });
    client.close();
  });

  it("sends the owner's order events and versioned balances, and nothing to anyone else", async () => {
    const market = await btcUsd();
    const seller = await funded({ BTC: "1" });
    const buyer = await funded({ USD: "10000" });
    const sellerSocket = await signedIn(seller);
    const opening = (await sellerSocket.next()) as { type: string; version: number };
    expect(opening).toMatchObject({ type: "balances" });
    const bystander = await signedIn(buyer);
    await bystander.next();
    bystander.send({ op: "unsubscribe", channel: "account" });
    await bystander.next();

    const ask = await exchange.placeOrder(market, {
      ...limit(seller, "sell", "60000", "0.1"),
      clientOrderId: "ask-1",
    });
    await expect(sellerSocket.next()).resolves.toEqual({
      type: "order",
      market: "BTC-USD",
      id: ask.id,
      clientOrderId: "ask-1",
      status: "open",
      filledQuantity: "0.00000000",
      sequence: 1,
    });
    const reserved = (await sellerSocket.next()) as { version: number; balances: unknown[] };
    expect(reserved.version).toBeGreaterThan(opening.version);
    expect(reserved.balances).toContainEqual({
      asset: "BTC",
      available: "0.90000000",
      reserved: "0.10000000",
    });

    // The fill reaches the maker too.
    await exchange.placeOrder(market, limit(buyer, "buy", "60000", "0.1"));
    await expect(sellerSocket.next()).resolves.toMatchObject({
      type: "order",
      id: ask.id,
      status: "filled",
      filledQuantity: "0.10000000",
      sequence: 2,
    });
    await expect(sellerSocket.next()).resolves.toMatchObject({ type: "balances" });

    // The buyer unsubscribed: the next thing it receives is the reply to this.
    bystander.send({ op: "subscribe", channel: "trades", market: "ETH-USD" });
    await expect(bystander.next()).resolves.toMatchObject({ type: "subscribed" });
    sellerSocket.close();
    bystander.close();
  });

  it("closes the connection when its access token expires", async () => {
    const userId = await funded({});
    const shortLived = createAccessTokens(TEST_SECRET, { ttlSeconds: 1 });
    const client = await connect(server);
    const closed = new Promise<number>((resolve) => {
      client.socket.on("close", (code) => {
        resolve(code);
      });
    });

    client.send({ op: "auth", token: await shortLived.issue(userId) });
    await expect(client.next()).resolves.toMatchObject({ type: "authenticated" });

    await expect(closed).resolves.toBe(TOKEN_EXPIRED_CLOSE_CODE);
  });
});

describe("fan-out through Redis", () => {
  // Two servers on one prefix stand in for two API processes: the first runs the market, the
  // second only holds sockets.
  const prefix = uniqueMarketDataPrefix();
  const { exchange } = freshServer({ marketDataPrefix: prefix });
  const { server: gateway } = freshServer({ marketDataPrefix: prefix });

  it("delivers trades and private events to a client connected to another process", async () => {
    const market = await btcUsd();
    const seller = await funded({ BTC: "1" });
    const buyer = await funded({ USD: "10000" });
    const client = await connect(gateway);
    client.send({ op: "auth", token: await tokens.issue(seller) });
    await client.next();
    client.send({ op: "subscribe", channel: "account" });
    await client.next();
    await client.next();
    client.send({ op: "subscribe", channel: "trades", market: "BTC-USD" });
    await client.next();

    const ask = await exchange.placeOrder(market, limit(seller, "sell", "60000", "0.1"));
    await exchange.placeOrder(market, limit(buyer, "buy", "60000", "0.1"));

    // Open, balances, trade, filled, balances.
    const received = [];
    for (let message = 0; message < 5; message++) {
      received.push(await client.next());
    }
    // Per channel, messages arrive in publish order; the balances reads race the rest.
    expect(received.filter((m) => (m as { type: string }).type === "order")).toEqual([
      expect.objectContaining({ id: ask.id, status: "open" }),
      expect.objectContaining({ id: ask.id, status: "filled" }),
    ]);
    expect(received.filter((m) => (m as { type: string }).type === "trade")).toEqual([
      expect.objectContaining({ sequence: 2, price: "60000.00000000", quantity: "0.10000000" }),
    ]);
    client.close();
  });
});

describe("heartbeats", () => {
  const { server } = freshServer({
    webSocketLimits: { heartbeatMs: 50, maxBufferedBytes: 1024 * 1024 },
  });

  it("keeps a client that answers pings", async () => {
    // Node's own WebSocket over a real port answers pings, as browsers do.
    await server.listen({ port: 0, host: "127.0.0.1" });
    const address = server.server.address();
    if (address === null || typeof address === "string") {
      throw new Error("server has no port");
    }
    const client = new globalThis.WebSocket(`ws://127.0.0.1:${address.port}/ws`);
    const replies: unknown[] = [];
    client.addEventListener("message", (event) => {
      if (typeof event.data === "string") {
        replies.push(JSON.parse(event.data));
      }
    });
    await new Promise((resolve) => client.addEventListener("open", resolve));

    await delay(300);
    client.send(JSON.stringify({ op: "subscribe", channel: "trades", market: "BTC-USD" }));

    await expect
      .poll(() => replies)
      .toEqual([{ type: "subscribed", channel: "trades", market: "BTC-USD" }]);
    expect(client.readyState).toBe(globalThis.WebSocket.OPEN);
    client.close();
  });

  it("terminates a client that never answers", async () => {
    // An injected client never answers pings: it stands in for a connection whose network
    // path died without a close.
    const client = await connect(server);
    const closed = client.closed();

    await expect(closed).resolves.toBe(1006);
  });
});

describe("a subscriber that falls behind", () => {
  const { exchange, server } = freshServer({
    webSocketLimits: { heartbeatMs: 60_000, maxBufferedBytes: 2048 },
  });

  it("is terminated once its unsent backlog passes the cap, while one that keeps up is not", async () => {
    const market = await btcUsd();
    const seller = await funded({ BTC: "1" });
    for (let level = 0; level < 20; level++) {
      await exchange.placeOrder(market, limit(seller, "sell", `${70000 + level}`, "0.01"));
    }
    const fast = await connect(server);
    fast.send({ op: "subscribe", channel: "book", market: "BTC-USD" });
    await fast.next();
    await fast.next();
    const slow = await connect(server);
    const slowClosed = slow.closed();

    // The slow client stops reading and keeps asking for the 20-level snapshot. The in-memory
    // pipe absorbs the first ~130 KB before the server's buffer grows, so it asks many times.
    slow.socket.pause();
    for (let request = 0; request < 400; request++) {
      slow.send({ op: "subscribe", channel: "book", market: "BTC-USD" });
    }

    await expect(slowClosed).resolves.toBe(1006);
    await exchange.placeOrder(market, limit(seller, "sell", "80000", "0.01"));
    await expect(fast.next()).resolves.toMatchObject({ type: "book_update", sequence: 21 });
    fast.close();
  });
});

// The client side of the book protocol, written the way a terminal would: keep the last
// sequence, drop what is not newer, and on a gap ask for a fresh snapshot.
class ClientBook {
  sequence = -1;
  gaps = 0;
  readonly levels = { buy: new Map<string, string>(), sell: new Map<string, string>() };

  // Returns true when the client must resubscribe.
  apply(message: unknown): boolean {
    const book = message as {
      type: string;
      sequence: number;
      firstSequence: number;
      bids: { price: string; quantity: string }[];
      asks: { price: string; quantity: string }[];
      changes: { side: "buy" | "sell"; price: string; quantity: string }[];
    };
    if (book.type === "book") {
      this.levels.buy = new Map(book.bids.map((level) => [level.price, level.quantity]));
      this.levels.sell = new Map(book.asks.map((level) => [level.price, level.quantity]));
      this.sequence = book.sequence;
      return false;
    }
    if (book.type !== "book_update" || book.sequence <= this.sequence) {
      return false;
    }
    if (book.firstSequence !== this.sequence + 1) {
      this.gaps++;
      return true;
    }
    for (const change of book.changes) {
      if (Number(change.quantity) === 0) {
        this.levels[change.side].delete(change.price);
      } else {
        this.levels[change.side].set(change.price, change.quantity);
      }
    }
    this.sequence = book.sequence;
    return false;
  }

  asks() {
    return [...this.levels.sell]
      .map(([price, quantity]) => ({ price, quantity }))
      .sort((a, b) => Number(a.price) - Number(b.price));
  }
}

describe("a client that misses a sequence", () => {
  it("detects the gap and resyncs to the server's book", async () => {
    // The publishing server's Redis goes through a proxy, so one publish can be lost to an
    // outage while the gateway's subscriber connection stays up.
    const proxy = await redisProxy();
    const publisher = createRedisClient(proxy.url);
    publisher.on("error", () => undefined);
    await publisher.connect();
    const exchange = new Exchange(db);
    const server = buildServer(
      { pool, redis: publisher, subscriber, db, tokens, exchange },
      { marketDataPrefix: uniqueMarketDataPrefix() },
    );
    try {
      const market = await btcUsd();
      const seller = await funded({ BTC: "1" });
      const client = await connect(server);
      const book = new ClientBook();
      const read = async () => {
        const message = await client.next();
        if (book.apply(message)) {
          client.send({ op: "subscribe", channel: "book", market: "BTC-USD" });
        }
        return message;
      };
      client.send({ op: "subscribe", channel: "book", market: "BTC-USD" });
      await read();
      await read();

      await exchange.placeOrder(market, limit(seller, "sell", "70000", "0.1"));
      await expect(read()).resolves.toMatchObject({ sequence: 1 });

      // Redis drops; the next command's publish is refused and lost.
      proxy.cut();
      await expect.poll(() => publisher.isReady).toBe(false);
      await exchange.placeOrder(market, limit(seller, "sell", "70100", "0.2"));
      await proxy.restore();
      await expect.poll(() => publisher.isReady, { timeout: 3000 }).toBe(true);

      // Sequence 3 arrives when the client expects 2: it resubscribes and takes the snapshot.
      await exchange.placeOrder(market, limit(seller, "sell", "70200", "0.3"));
      await expect(read()).resolves.toMatchObject({ firstSequence: 3, sequence: 3 });
      await expect(read()).resolves.toMatchObject({ type: "subscribed" });
      await expect(read()).resolves.toMatchObject({ type: "book", sequence: 3 });

      expect(book.gaps).toBe(1);
      const rest = await server.inject({ method: "GET", url: "/markets/BTC-USD/book" });
      expect(book.asks()).toEqual(rest.json<{ asks: unknown[] }>().asks);
      expect(book.asks()).toHaveLength(3);
      client.close();
    } finally {
      await server.close();
      proxy.cut();
      publisher.destroy();
    }
  });
});
