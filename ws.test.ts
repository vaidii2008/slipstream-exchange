import { describe, expect, it } from "vitest";
import type { WebSocket } from "ws";
import { useTestServer } from "./testing.ts";
import { decode } from "./ws.ts";

const { app } = useTestServer();

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

    client.send({ op: "subscribe", channel: "book", market: "BTC-USD" });
    client.send({ op: "unsubscribe", channel: "book", market: "BTC-USD" });
    client.send({ op: "subscribe", channel: "trades", market: "BTC-USD" });

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
