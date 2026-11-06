import { afterAll, describe, expect, it } from "vitest";
import { Exchange } from "./exchange.ts";
import { buildServer } from "./server.ts";
import { useTestServer } from "./testing.ts";

const { pool, db, tokens, app: sharedApp, uniqueEmail } = useTestServer();

// Each helper takes the server to talk to. Most tests share the file's server; a scenario that
// needs an empty book builds its own around a fresh Exchange.
type Server = typeof sharedApp;

async function signedInUser(app: Server = sharedApp): Promise<string> {
  const email = uniqueEmail("trading-test");
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
  return `Bearer ${loggedIn.json<{ accessToken: string }>().accessToken}`;
}

async function fund(
  authorization: string,
  asset: string,
  amount: string,
  app: Server = sharedApp,
): Promise<void> {
  const response = await app.inject({
    method: "POST",
    url: "/deposits",
    headers: { authorization },
    payload: { asset, amount },
  });
  expect(response.statusCode).toBe(201);
}

function postOrder(
  authorization: string | undefined,
  payload: Record<string, unknown>,
  app: Server = sharedApp,
) {
  return app.inject({
    method: "POST",
    url: "/orders",
    headers: authorization === undefined ? {} : { authorization },
    payload,
  });
}

const aBuy = { market: "BTC-USD", side: "buy", type: "limit", price: "60000", quantity: "0.1" };

describe("POST /orders", () => {
  it("places a limit order and returns it at the market's scales", async () => {
    const authorization = await signedInUser();
    await fund(authorization, "USD", "6000");

    const response = await postOrder(authorization, aBuy);

    expect(response.statusCode).toBe(201);
    expect(response.json<unknown>()).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/) as unknown,
      market: "BTC-USD",
      side: "buy",
      type: "limit",
      price: "60000.00000000",
      quantity: "0.10000000",
      status: "open",
      filledQuantity: "0.00000000",
      fills: [],
    });
  });

  it("shows the reservation in the caller's balances", async () => {
    const authorization = await signedInUser();
    await fund(authorization, "USD", "6000");
    await postOrder(authorization, { ...aBuy, quantity: "0.05" });

    const response = await sharedApp.inject({
      method: "GET",
      url: "/balances",
      headers: { authorization },
    });

    expect(response.json<{ balances: unknown[] }>().balances).toContainEqual({
      asset: "USD",
      available: "3000.00000000",
      reserved: "3000.00000000",
    });
  });

  it("requires an access token", async () => {
    const response = await postOrder(undefined, aBuy);

    expect(response.statusCode).toBe(401);
  });

  it("refuses an order the caller cannot fund with 422", async () => {
    const authorization = await signedInUser();
    await fund(authorization, "USD", "5999.99");

    const response = await postOrder(authorization, aBuy);

    expect(response.statusCode).toBe(422);
    expect(response.json<unknown>()).toMatchObject({ error: "insufficient_funds" });
  });

  it.each([
    [{ market: "DOGE-USD" }, "market", "is not a listed market"],
    [{ price: "60000.005" }, "price", "must be a multiple of the market's tick size"],
    [{ price: "0" }, "price", "must be positive"],
    [{ price: "1.000000001" }, "price", "has more decimals than the asset allows"],
    [{ price: "-1" }, "price", "must be positive"],
    [{ quantity: "0.00005" }, "quantity", "is below the market's minimum quantity"],
    [{ quantity: "0.00015" }, "quantity", "must be a multiple of the market's quantity step"],
    [{ quantity: "1e-3" }, "quantity", "must be a plain decimal string such as 1.5"],
  ])("rejects %j on %s: %s", async (change, field, message) => {
    const authorization = await signedInUser();
    await fund(authorization, "USD", "100000");

    const response = await postOrder(authorization, { ...aBuy, ...change });

    expect(response.statusCode).toBe(400);
    expect(response.json<unknown>()).toEqual({
      error: "invalid_request",
      issues: [{ field, message }],
    });
  });

  it.each([
    ["a market order, until Session 5", { type: "market" }],
    ["a JSON number price, which has been through a float", { price: 60000 }],
    ["an unknown side", { side: "short" }],
  ])("rejects %s", async (_label, change) => {
    const authorization = await signedInUser();

    const response = await postOrder(authorization, { ...aBuy, ...change });

    expect(response.statusCode).toBe(400);
    expect(response.json<unknown>()).toMatchObject({ error: "invalid_request" });
  });
});

describe("two users trading through the API", () => {
  const app = buildServer({
    pool,
    redis: { ping: () => Promise.resolve("PONG") },
    db,
    tokens,
    exchange: new Exchange(db),
  });

  afterAll(async () => {
    await app.close();
  });

  type Balance = { asset: string; available: string; reserved: string };

  async function balances(authorization: string): Promise<Record<string, [string, string]>> {
    const response = await app.inject({
      method: "GET",
      url: "/balances",
      headers: { authorization },
    });
    const rows = response.json<{ balances: Balance[] }>().balances;
    return Object.fromEntries(rows.map((row) => [row.asset, [row.available, row.reserved]]));
  }

  async function place(authorization: string, side: string, price: string, quantity: string) {
    const response = await postOrder(
      authorization,
      { market: "BTC-USD", side, type: "limit", price, quantity },
      app,
    );
    expect(response.statusCode).toBe(201);
    return response.json<{ status: string; filledQuantity: string; fills: unknown[] }>();
  }

  // Each step's expected balances are worked out by hand in the comment above it.
  it("places, partly fills and fully fills orders, keeping both users' money whole", async () => {
    const alice = await signedInUser(app);
    const bob = await signedInUser(app);
    await fund(alice, "BTC", "1", app);
    await fund(bob, "USD", "100000", app);

    // Alice offers 0.5 BTC at 60,000. Nothing to match, so it rests with 0.5 BTC reserved.
    await expect(place(alice, "sell", "60000", "0.5")).resolves.toMatchObject({
      status: "open",
      filledQuantity: "0.00000000",
    });

    // Bob bids 0.2 at 60,100 and fills at Alice's 60,000. He reserved 12,020 and paid 12,000,
    // so 20 comes back. Alice's order is now partly filled, 0.3 still reserved.
    await expect(place(bob, "buy", "60100", "0.2")).resolves.toMatchObject({
      status: "filled",
      filledQuantity: "0.20000000",
      fills: [{ price: "60000.00000000", quantity: "0.20000000" }],
    });
    await expect(balances(alice)).resolves.toMatchObject({
      BTC: ["0.50000000", "0.30000000"],
      USD: ["12000.00000000", "0.00000000"],
    });
    await expect(balances(bob)).resolves.toMatchObject({
      BTC: ["0.20000000", "0.00000000"],
      USD: ["88000.00000000", "0.00000000"],
    });

    // Bob bids 0.5 at 60,000: takes Alice's last 0.3, and 0.2 rests at 60,000 with 12,000
    // still reserved. Alice's order is filled.
    await expect(place(bob, "buy", "60000", "0.5")).resolves.toMatchObject({
      status: "open",
      filledQuantity: "0.30000000",
    });
    await expect(balances(alice)).resolves.toMatchObject({
      BTC: ["0.50000000", "0.00000000"],
      USD: ["30000.00000000", "0.00000000"],
    });
    await expect(balances(bob)).resolves.toMatchObject({
      BTC: ["0.50000000", "0.00000000"],
      USD: ["58000.00000000", "12000.00000000"],
    });

    // Alice offers 0.2 at 59,000 and fills against Bob's resting bid at his 60,000: the maker
    // sets the price, so the seller gets more than she asked.
    await expect(place(alice, "sell", "59000", "0.2")).resolves.toMatchObject({
      status: "filled",
      filledQuantity: "0.20000000",
      fills: [{ price: "60000.00000000", quantity: "0.20000000" }],
    });
    await expect(balances(alice)).resolves.toMatchObject({
      BTC: ["0.30000000", "0.00000000"],
      USD: ["42000.00000000", "0.00000000"],
    });
    await expect(balances(bob)).resolves.toMatchObject({
      BTC: ["0.70000000", "0.00000000"],
      USD: ["58000.00000000", "0.00000000"],
    });
    // Nothing created or lost: 1 BTC and 100,000 USD between them, as deposited.
  });
});
