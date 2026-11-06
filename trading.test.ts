import { describe, expect, it } from "vitest";
import { useTestServer } from "./testing.ts";

const { app, uniqueEmail } = useTestServer();

async function signedInUser(): Promise<string> {
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

async function fund(authorization: string, asset: string, amount: string): Promise<void> {
  const response = await app.inject({
    method: "POST",
    url: "/deposits",
    headers: { authorization },
    payload: { asset, amount },
  });
  expect(response.statusCode).toBe(201);
}

function postOrder(authorization: string | undefined, payload: Record<string, unknown>) {
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

    const response = await app.inject({
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
