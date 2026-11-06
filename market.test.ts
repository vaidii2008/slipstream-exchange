import { afterAll, describe, expect, it } from "vitest";
import { Exchange } from "./exchange.ts";
import { buildServer } from "./server.ts";
import { useTestServer } from "./testing.ts";

const { pool, redis, subscriber, db, tokens, uniqueEmail } = useTestServer();

// Its own exchange, so the book holds only what these tests rest.
const app = buildServer({
  pool,
  redis,
  subscriber,
  db,
  tokens,
  exchange: new Exchange(db),
});

afterAll(async () => {
  await app.close();
});

// A signed-in, funded user, with their id so a test can check it never appears.
async function trader(holdings: Record<string, string>) {
  const email = uniqueEmail("market-test");
  await app.inject({
    method: "POST",
    url: "/register",
    payload: { email, password: "hunter2hunter2" },
  });
  const loggedIn = await app.inject({
    method: "POST",
    url: "/login",
    payload: { email, password: "hunter2hunter2" },
  });
  const authorization = `Bearer ${loggedIn.json<{ accessToken: string }>().accessToken}`;
  for (const [asset, amount] of Object.entries(holdings)) {
    await app.inject({
      method: "POST",
      url: "/deposits",
      headers: { authorization },
      payload: { asset, amount },
    });
  }
  const me = await app.inject({ method: "GET", url: "/me", headers: { authorization } });
  return { authorization, id: me.json<{ id: string }>().id };
}

async function place(
  authorization: string,
  market: string,
  side: string,
  price: string,
  quantity: string,
): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/orders",
    headers: { authorization },
    payload: { market, side, type: "limit", price, quantity },
  });
  expect(response.statusCode).toBe(201);
  return response.json<{ id: string }>().id;
}

describe("GET /markets/:symbol/book", () => {
  it("aggregates each price level, best first, and names no user or order", async () => {
    const alice = await trader({ BTC: "1", USD: "10000" });
    const bob = await trader({ BTC: "1" });
    const orderIds = [
      await place(alice.authorization, "BTC-USD", "sell", "60000", "0.1"),
      await place(bob.authorization, "BTC-USD", "sell", "60000", "0.2"),
      await place(bob.authorization, "BTC-USD", "sell", "60100", "0.3"),
      await place(alice.authorization, "BTC-USD", "buy", "59000", "0.05"),
    ];

    const response = await app.inject({ method: "GET", url: "/markets/BTC-USD/book" });

    expect(response.statusCode).toBe(200);
    expect(response.json<unknown>()).toEqual({
      market: "BTC-USD",
      sequence: 4,
      bids: [{ price: "59000.00000000", quantity: "0.05000000" }],
      asks: [
        { price: "60000.00000000", quantity: "0.30000000" },
        { price: "60100.00000000", quantity: "0.30000000" },
      ],
    });
    for (const id of [alice.id, bob.id, ...orderIds]) {
      expect(response.body).not.toContain(id);
    }
  });

  it("returns only as many levels as asked for", async () => {
    const response = await app.inject({ method: "GET", url: "/markets/BTC-USD/book?depth=1" });

    expect(response.json<{ asks: unknown[] }>().asks).toEqual([
      { price: "60000.00000000", quantity: "0.30000000" },
    ]);
  });

  it("serves an empty book for a market nobody has traded", async () => {
    const response = await app.inject({ method: "GET", url: "/markets/ETH-USD/book" });

    expect(response.json<unknown>()).toEqual({
      market: "ETH-USD",
      sequence: 0,
      bids: [],
      asks: [],
    });
  });
});

describe("GET /markets/:symbol/trades", () => {
  it("lists trades newest first with the taker's side and no user or order", async () => {
    const seller = await trader({ ETH: "1" });
    const buyer = await trader({ USD: "10000" });
    const orderIds = [
      await place(seller.authorization, "ETH-USD", "sell", "3141.59", "0.5"),
      await place(buyer.authorization, "ETH-USD", "buy", "3141.59", "0.2"),
      await place(buyer.authorization, "ETH-USD", "buy", "3141.59", "0.1"),
    ];

    const response = await app.inject({ method: "GET", url: "/markets/ETH-USD/trades?limit=200" });

    expect(response.statusCode).toBe(200);
    const { trades } = response.json<{ trades: { id: number; price: string }[] }>();
    // Other test files trade ETH-USD at the same time, so find ours by their unusual price
    // rather than assume they are the only ones.
    const ids = trades.map((trade) => trade.id);
    expect(ids).toEqual([...ids].sort((a, b) => b - a));
    const ours = trades.filter((trade) => trade.price === "3141.59000000");
    expect(ours).toEqual([
      {
        id: expect.any(Number) as unknown,
        price: "3141.59000000",
        quantity: "0.10000000",
        takerSide: "buy",
        createdAt: expect.any(String) as unknown,
      },
      expect.objectContaining({ quantity: "0.20000000", takerSide: "buy" }),
    ]);
    for (const id of [seller.id, buyer.id, ...orderIds]) {
      expect(response.body).not.toContain(id);
    }
  });
});

describe("market data requests", () => {
  it.each(["/markets/DOGE-USD/book", "/markets/DOGE-USD/trades"])(
    "answers 404 for %s",
    async (url) => {
      const response = await app.inject({ method: "GET", url });

      expect(response.statusCode).toBe(404);
      expect(response.json<unknown>()).toEqual({ error: "not_found" });
    },
  );

  it.each([
    "/markets/BTC-USD/book?depth=0",
    "/markets/BTC-USD/book?depth=201",
    "/markets/BTC-USD/trades?limit=abc",
    "/markets/BTC-USD/trades?userId=1",
  ])("rejects %s with 400", async (url) => {
    const response = await app.inject({ method: "GET", url });

    expect(response.statusCode).toBe(400);
  });
});

describe("GET /markets", () => {
  it("lists every market with its tick, step and minimum at the asset's scale", async () => {
    const response = await app.inject({ method: "GET", url: "/markets" });

    expect(response.statusCode).toBe(200);
    expect(response.json<unknown>()).toEqual({
      markets: [
        {
          symbol: "BTC-USD",
          baseAsset: "BTC",
          quoteAsset: "USD",
          tickSize: "0.01000000",
          quantityStep: "0.00010000",
          minQuantity: "0.00010000",
        },
        {
          symbol: "ETH-USD",
          baseAsset: "ETH",
          quoteAsset: "USD",
          tickSize: "0.01000000",
          quantityStep: "0.00100000",
          minQuantity: "0.00100000",
        },
      ],
    });
  });
});
