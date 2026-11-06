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
      clientOrderId: null,
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
    ["a market order with a price", { type: "market" }],
    ["a field the API does not know", { timeInForce: "IOC" }],
    ["a JSON number price, which has been through a float", { price: 60000 }],
    ["an unknown side", { side: "short" }],
  ])("rejects %s", async (_label, change) => {
    const authorization = await signedInUser();

    const response = await postOrder(authorization, { ...aBuy, ...change });

    expect(response.statusCode).toBe(400);
    expect(response.json<unknown>()).toMatchObject({ error: "invalid_request" });
  });
});

describe("POST /orders with a client order id", () => {
  // Far below any ask another test rests in the shared book, so these orders never fill.
  const keyed = (clientOrderId: string) => ({
    ...aBuy,
    price: "100",
    quantity: "1",
    clientOrderId,
  });

  async function usdOf(authorization: string) {
    const response = await sharedApp.inject({
      method: "GET",
      url: "/balances",
      headers: { authorization },
    });
    return response
      .json<{ balances: { asset: string; available: string; reserved: string }[] }>()
      .balances.find((balance) => balance.asset === "USD");
  }

  it("answers a repeat with the original order and 200, and reserves once", async () => {
    const authorization = await signedInUser();
    await fund(authorization, "USD", "100");

    const first = await postOrder(authorization, keyed("retry-1"));
    // The whole balance is reserved now, so placing it again would fail for funds.
    const repeat = await postOrder(authorization, keyed("retry-1"));

    expect(first.statusCode).toBe(201);
    expect(repeat.statusCode).toBe(200);
    expect(repeat.json<unknown>()).toEqual({
      id: first.json<{ id: string }>().id,
      market: "BTC-USD",
      side: "buy",
      type: "limit",
      price: "100.00000000",
      quantity: "1.00000000",
      clientOrderId: "retry-1",
      status: "open",
      filledQuantity: "0.00000000",
      fills: [],
    });
    await expect(usdOf(authorization)).resolves.toEqual({
      asset: "USD",
      available: "0.00000000",
      reserved: "100.00000000",
    });
  });

  it("places one order when the same request arrives several times at once", async () => {
    const authorization = await signedInUser();
    await fund(authorization, "USD", "100");

    const responses = await Promise.all(
      Array.from({ length: 5 }, () => postOrder(authorization, keyed("burst-1"))),
    );

    const codes = responses.map((response) => response.statusCode).sort();
    expect(codes).toEqual([200, 200, 200, 200, 201]);
    const ids = new Set(responses.map((response) => response.json<{ id: string }>().id));
    expect(ids.size).toBe(1);
    await expect(usdOf(authorization)).resolves.toMatchObject({ reserved: "100.00000000" });
  });

  it("refuses the same key on a different order with 409", async () => {
    const authorization = await signedInUser();
    await fund(authorization, "USD", "1000");
    await postOrder(authorization, keyed("reused-1"));

    const response = await postOrder(authorization, { ...keyed("reused-1"), price: "101" });

    expect(response.statusCode).toBe(409);
    expect(response.json<unknown>()).toMatchObject({ error: "client_order_id_reused" });
    await expect(usdOf(authorization)).resolves.toMatchObject({ reserved: "100.00000000" });
  });

  it("scopes keys to the user, so two users can use the same one", async () => {
    const alice = await signedInUser();
    const bob = await signedInUser();
    await fund(alice, "USD", "100");
    await fund(bob, "USD", "100");

    await expect(postOrder(alice, keyed("shared-1"))).resolves.toMatchObject({ statusCode: 201 });
    await expect(postOrder(bob, keyed("shared-1"))).resolves.toMatchObject({ statusCode: 201 });
  });

  it.each(["", "has space", "x".repeat(65)])("rejects the key %j with 400", async (key) => {
    const authorization = await signedInUser();

    const response = await postOrder(authorization, keyed(key));

    expect(response.statusCode).toBe(400);
  });
});

describe("DELETE /orders/:id", () => {
  function cancel(authorization: string, id: string) {
    return sharedApp.inject({ method: "DELETE", url: `/orders/${id}`, headers: { authorization } });
  }

  async function restingBuy(authorization: string): Promise<string> {
    await fund(authorization, "USD", "1000");
    // Far below any ask another test could rest, so it never fills.
    const response = await postOrder(authorization, { ...aBuy, price: "100", quantity: "1" });
    expect(response.json<unknown>()).toMatchObject({ status: "open" });
    return response.json<{ id: string }>().id;
  }

  it("cancels the caller's open order and returns its reservation", async () => {
    const authorization = await signedInUser();
    const id = await restingBuy(authorization);

    const response = await cancel(authorization, id);

    expect(response.statusCode).toBe(200);
    expect(response.json<unknown>()).toMatchObject({
      id,
      type: "limit",
      price: "100.00000000",
      quantity: "1.00000000",
      filledQuantity: "0.00000000",
      status: "cancelled",
    });
    const balances = await sharedApp.inject({
      method: "GET",
      url: "/balances",
      headers: { authorization },
    });
    expect(balances.json<{ balances: unknown[] }>().balances).toContainEqual({
      asset: "USD",
      available: "1000.00000000",
      reserved: "0.00000000",
    });
  });

  it("answers 409 for an order that is already cancelled", async () => {
    const authorization = await signedInUser();
    const id = await restingBuy(authorization);
    await cancel(authorization, id);

    const response = await cancel(authorization, id);

    expect(response.statusCode).toBe(409);
    expect(response.json<unknown>()).toEqual({
      error: "order_not_open",
      message: "order is cancelled",
    });
  });

  it("answers 404 for another user's order, exactly as for one that does not exist", async () => {
    const owner = await signedInUser();
    const id = await restingBuy(owner);
    const stranger = await signedInUser();

    const theirs = await cancel(stranger, id);
    const missing = await cancel(stranger, "00000000-0000-4000-8000-000000000000");

    expect(theirs.statusCode).toBe(404);
    expect(theirs.json<unknown>()).toEqual(missing.json<unknown>());
    await expect(cancel(owner, id)).resolves.toMatchObject({ statusCode: 200 });
  });

  it("rejects an id that is not a uuid with 400", async () => {
    const authorization = await signedInUser();

    const response = await cancel(authorization, "42");

    expect(response.statusCode).toBe(400);
  });
});

describe("GET /orders and GET /fills", () => {
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

  function get(authorization: string, url: string) {
    return app.inject({ method: "GET", url, headers: { authorization } });
  }

  async function place(authorization: string, side: string, price: string, quantity: string) {
    const response = await postOrder(
      authorization,
      { market: "BTC-USD", side, type: "limit", price, quantity },
      app,
    );
    return response.json<{ id: string }>().id;
  }

  // Alice takes all of Bob's ask, rests a bid at 50,000 and cancels one at 40,000. No ask is
  // left behind, so the next scenario's Alice trades with the next scenario's Bob.
  async function scenario() {
    const alice = await signedInUser(app);
    const bob = await signedInUser(app);
    await fund(alice, "USD", "10000", app);
    await fund(bob, "BTC", "1", app);
    const ask = await place(bob, "sell", "60000", "0.05");
    const taken = await place(alice, "buy", "60000", "0.05");
    const resting = await place(alice, "buy", "50000", "0.01");
    const cancelled = await place(alice, "buy", "40000", "0.01");
    await app.inject({
      method: "DELETE",
      url: `/orders/${cancelled}`,
      headers: { authorization: alice },
    });
    return { alice, bob, ask, taken, resting, cancelled };
  }

  const ids = (response: { json: <T>() => T }) =>
    response.json<{ orders: { id: string }[] }>().orders.map((order) => order.id);

  it("lists open, closed and all orders, newest first", async () => {
    const { alice, taken, resting, cancelled } = await scenario();

    expect(ids(await get(alice, "/orders?status=open"))).toEqual([resting]);
    expect(ids(await get(alice, "/orders?status=closed"))).toEqual([cancelled, taken]);
    expect(ids(await get(alice, "/orders"))).toEqual([cancelled, resting, taken]);
    expect(ids(await get(alice, "/orders?limit=1"))).toEqual([cancelled]);
    expect(ids(await get(alice, "/orders?market=ETH-USD"))).toEqual([]);

    const [open] = (await get(alice, "/orders?status=open")).json<{ orders: unknown[] }>().orders;
    expect(open).toEqual({
      id: resting,
      market: "BTC-USD",
      side: "buy",
      type: "limit",
      price: "50000.00000000",
      quantity: "0.01000000",
      filledQuantity: "0.00000000",
      status: "open",
      clientOrderId: null,
      createdAt: expect.any(String) as unknown,
      updatedAt: expect.any(String) as unknown,
    });
  });

  it("lists each user's side of their trades as maker or taker", async () => {
    const { alice, bob, ask, taken } = await scenario();

    const fill = { market: "BTC-USD", price: "60000.00000000", quantity: "0.05000000" };
    expect((await get(alice, "/fills")).json<unknown>()).toEqual({
      fills: [
        {
          ...fill,
          tradeId: expect.any(Number) as unknown,
          orderId: taken,
          side: "buy",
          role: "taker",
          createdAt: expect.any(String) as unknown,
        },
      ],
    });
    expect((await get(bob, "/fills")).json<unknown>()).toMatchObject({
      fills: [{ ...fill, orderId: ask, side: "sell", role: "maker" }],
    });
  });

  it.each(["/orders?status=pending", "/orders?limit=0", "/orders?limit=501", "/fills?sort=asc"])(
    "rejects %s with 400",
    async (url) => {
      const authorization = await signedInUser(app);

      const response = await get(authorization, url);

      expect(response.statusCode).toBe(400);
    },
  );
});

describe("POST /orders with a market order", () => {
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

  it("fills against the book and returns no price of its own", async () => {
    const seller = await signedInUser(app);
    const buyer = await signedInUser(app);
    await fund(seller, "BTC", "1", app);
    await fund(buyer, "USD", "10000", app);
    await postOrder(seller, { ...aBuy, side: "sell", price: "60000" }, app);

    const response = await postOrder(
      buyer,
      { market: "BTC-USD", side: "buy", type: "market", quantity: "0.1" },
      app,
    );

    expect(response.statusCode).toBe(201);
    expect(response.json<unknown>()).toMatchObject({
      type: "market",
      price: null,
      status: "filled",
      fills: [{ price: "60000.00000000", quantity: "0.10000000" }],
    });
  });

  it("refuses one with nothing to trade against with 422 no_liquidity", async () => {
    const buyer = await signedInUser(app);
    await fund(buyer, "USD", "10000", app);

    const response = await postOrder(
      buyer,
      { market: "ETH-USD", side: "buy", type: "market", quantity: "1" },
      app,
    );

    expect(response.statusCode).toBe(422);
    expect(response.json<unknown>()).toMatchObject({ error: "no_liquidity" });
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
