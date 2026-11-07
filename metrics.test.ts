import { afterAll, describe, expect, it } from "vitest";
import type { WebSocket } from "ws";
import { Exchange } from "./exchange.ts";
import { buildServer } from "./server.ts";
import { uniqueMarketDataPrefix, useTestServer } from "./testing.ts";

const { pool, redis, subscriber, db, tokens, uniqueEmail, testMarket } = useTestServer();

// Its own server with a limit of 2 orders a second, so a third order in the same second is
// refused, and its own metrics, so counts from other tests in the file stay out of these.
function freshServer() {
  const server = buildServer(
    { pool, redis, subscriber, db, tokens, exchange: new Exchange(db) },
    { marketDataPrefix: uniqueMarketDataPrefix(), orderRateLimit: { limit: 2, windowMs: 1000 } },
  );
  afterAll(async () => {
    await server.close();
  });
  return server;
}

type Server = ReturnType<typeof freshServer>;

async function trader(server: Server): Promise<string> {
  const email = uniqueEmail("metrics-test");
  await server.inject({
    method: "POST",
    url: "/register",
    payload: { email, password: "hunter2hunter2" },
  });
  const loggedIn = await server.inject({
    method: "POST",
    url: "/login",
    payload: { email, password: "hunter2hunter2" },
  });
  const authorization = `Bearer ${loggedIn.json<{ accessToken: string }>().accessToken}`;
  for (const [asset, amount] of [
    ["USD", "100000"],
    ["BTC", "1"],
  ]) {
    const deposited = await server.inject({
      method: "POST",
      url: "/deposits",
      headers: { authorization },
      payload: { asset, amount },
    });
    expect(deposited.statusCode).toBe(201);
  }
  return authorization;
}

async function scrape(server: Server): Promise<string> {
  const response = await server.inject({ method: "GET", url: "/metrics" });
  expect(response.statusCode).toBe(200);
  return response.body;
}

// The value of one sample in Prometheus's text format, or undefined if it was never set.
// Labels are matched exactly, in the order prom-client writes them.
function sample(text: string, name: string, labels: Record<string, string> = {}): number {
  const rendered = Object.entries(labels)
    .map(([key, value]) => `${key}="${value}"`)
    .join(",");
  const series = rendered === "" ? name : `${name}{${rendered}}`;
  const line = text.split("\n").find((candidate) => candidate.startsWith(`${series} `));
  return line === undefined ? Number.NaN : Number(line.slice(series.length + 1));
}

describe("GET /metrics", () => {
  it("serves Prometheus's text format without a token", async () => {
    const server = freshServer();
    const response = await server.inject({ method: "GET", url: "/metrics" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toMatch(/^text\/plain; version=0\.0\.4/);
    expect(response.body).toContain("# TYPE slipstream_orders_total counter");
    expect(response.body).toContain("# TYPE slipstream_websocket_connections gauge");
    // Off unless main.ts asks for them.
    expect(response.body).not.toContain("process_cpu_seconds_total");
  });

  it("counts placements by market and outcome, and the trades they make", async () => {
    const server = freshServer();
    const { symbol } = await testMarket("BTC-USD");
    const [seller, buyer] = await Promise.all([trader(server), trader(server)]);
    const order = (authorization: string, side: string, price: string) =>
      server.inject({
        method: "POST",
        url: "/orders",
        headers: { authorization },
        payload: { market: symbol, side, type: "limit", price, quantity: "0.1" },
      });

    expect((await order(seller, "sell", "60000")).statusCode).toBe(201);
    expect((await order(seller, "sell", "60001")).statusCode).toBe(201);
    expect((await order(buyer, "buy", "60000")).statusCode).toBe(201);
    // Off the 0.01 tick.
    expect((await order(buyer, "buy", "60000.001")).statusCode).toBe(400);
    // The seller's third order this second.
    expect((await order(seller, "sell", "60002")).statusCode).toBe(429);

    const text = await scrape(server);
    const orders = (market: string, outcome: string) =>
      sample(text, "slipstream_orders_total", { market, outcome });
    expect(orders(symbol, "open")).toBe(2);
    expect(orders(symbol, "filled")).toBe(1);
    expect(orders(symbol, "rejected")).toBe(1);
    expect(orders("none", "rate_limited")).toBe(1);
    expect(sample(text, "slipstream_trades_total", { market: symbol })).toBe(1);
    // One observation per command that reached the queue: the three placed orders. The
    // rejected and rate-limited ones never did.
    for (const histogram of ["queue_wait", "command", "match"]) {
      expect(sample(text, `slipstream_${histogram}_seconds_count`, { market: symbol })).toBe(3);
    }
    // Le is the bucket's upper bound: every match took 10 ms or less.
    expect(sample(text, "slipstream_match_seconds_bucket", { le: "0.01", market: symbol })).toBe(3);
  });

  it("counts an order refused for its body under no market, whatever market it names", async () => {
    const server = freshServer();
    const authorization = await trader(server);
    const response = await server.inject({
      method: "POST",
      url: "/orders",
      headers: { authorization },
      payload: { market: "made-up-market", side: "buy", type: "limit", price: "1", quantity: "1" },
    });
    expect(response.statusCode).toBe(400);

    const text = await scrape(server);
    expect(sample(text, "slipstream_orders_total", { market: "none", outcome: "invalid" })).toBe(1);
    expect(text).not.toContain("made-up-market");
  });

  it("tracks open WebSocket connections up and back down", async () => {
    const server = freshServer();
    await server.ready();
    const connections = async () =>
      sample(await scrape(server), "slipstream_websocket_connections");

    const first: WebSocket = await server.injectWS("/ws");
    const second: WebSocket = await server.injectWS("/ws");
    expect(await connections()).toBe(2);

    first.terminate();
    // The server's close handler runs when its end of the socket closes, a tick later.
    await expect.poll(connections).toBe(1);
    second.terminate();
    await expect.poll(connections).toBe(0);
  });
});
