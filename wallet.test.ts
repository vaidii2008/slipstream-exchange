import { and, eq, sum } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { fromNumeric } from "./money.ts";
import { ledgerAccounts, ledgerEntries } from "./schema.ts";
import { useTestServer } from "./testing.ts";

const { db, app, uniqueEmail } = useTestServer();

async function signedInUser(): Promise<{ userId: string; authorization: string }> {
  const email = uniqueEmail("wallet-test");
  const registered = await app.inject({
    method: "POST",
    url: "/register",
    payload: { email, password: "hunter2hunter2" },
  });
  const loggedIn = await app.inject({
    method: "POST",
    url: "/login",
    payload: { email, password: "hunter2hunter2" },
  });
  return {
    userId: registered.json<{ id: string }>().id,
    authorization: `Bearer ${loggedIn.json<{ accessToken: string }>().accessToken}`,
  };
}

function postDeposit(authorization: string | undefined, payload: Record<string, unknown>) {
  return app.inject({
    method: "POST",
    url: "/deposits",
    headers: authorization === undefined ? {} : { authorization },
    payload,
  });
}

// Read straight from the ledger, so this test does not depend on the balances endpoint.
async function ledgerBalance(userId: string, asset: string, scale: number): Promise<bigint> {
  const [row] = await db
    .select({ total: sum(ledgerEntries.amount) })
    .from(ledgerEntries)
    .innerJoin(ledgerAccounts, eq(ledgerAccounts.id, ledgerEntries.accountId))
    .where(
      and(
        eq(ledgerAccounts.userId, userId),
        eq(ledgerAccounts.asset, asset),
        eq(ledgerAccounts.bucket, "available"),
      ),
    );
  return fromNumeric(row?.total ?? "0", scale);
}

describe("POST /deposits", () => {
  it("credits the caller's available balance and echoes the amount at the asset's scale", async () => {
    const { userId, authorization } = await signedInUser();

    const response = await postDeposit(authorization, { asset: "BTC", amount: "1.5" });

    expect(response.statusCode).toBe(201);
    expect(response.json<unknown>()).toMatchObject({ asset: "BTC", amount: "1.50000000" });
    await expect(ledgerBalance(userId, "BTC", 8)).resolves.toBe(150_000_000n);
  });

  it("adds repeated deposits together", async () => {
    const { userId, authorization } = await signedInUser();

    await postDeposit(authorization, { asset: "USD", amount: "100" });
    await postDeposit(authorization, { asset: "USD", amount: "0.01" });

    await expect(ledgerBalance(userId, "USD", 8)).resolves.toBe(10_001_000_000n);
  });

  it("requires an access token", async () => {
    const response = await postDeposit(undefined, { asset: "BTC", amount: "1" });

    expect(response.statusCode).toBe(401);
    expect(response.json<unknown>()).toEqual({ error: "missing_token" });
  });

  it("rejects an asset that is not listed", async () => {
    const { authorization } = await signedInUser();

    const response = await postDeposit(authorization, { asset: "DOGE", amount: "1" });

    expect(response.statusCode).toBe(400);
    expect(response.json<unknown>()).toEqual({
      error: "invalid_request",
      issues: [{ field: "asset", message: "is not a listed asset" }],
    });
  });

  it("rejects a JSON number, which would already have passed through a float", async () => {
    const { authorization } = await signedInUser();

    const response = await postDeposit(authorization, { asset: "BTC", amount: 0.1 });

    expect(response.statusCode).toBe(400);
    expect(response.json<unknown>()).toMatchObject({ error: "invalid_request" });
  });

  it.each([
    ["0", "must be positive"],
    ["0.00", "must be positive"],
    ["-5", "must be positive"],
    ["0.000000001", "has more decimals than the asset allows"],
    ["1e3", "must be a plain decimal string such as 1.5"],
    ["1".repeat(19), "is too large"],
  ])("rejects a USD amount of %j: %s", async (amount, message) => {
    const { userId, authorization } = await signedInUser();

    const response = await postDeposit(authorization, { asset: "USD", amount });

    expect(response.statusCode).toBe(400);
    expect(response.json<unknown>()).toEqual({
      error: "invalid_request",
      issues: [{ field: "amount", message }],
    });
    await expect(ledgerBalance(userId, "USD", 8)).resolves.toBe(0n);
  });
});

describe("GET /balances", () => {
  it("reports deposits as available, every asset at its own scale", async () => {
    const { authorization } = await signedInUser();
    await postDeposit(authorization, { asset: "BTC", amount: "0.25" });
    await postDeposit(authorization, { asset: "USD", amount: "1000" });

    const response = await app.inject({
      method: "GET",
      url: "/balances",
      headers: { authorization },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<unknown>()).toEqual({
      balances: [
        { asset: "BTC", available: "0.25000000", reserved: "0.00000000" },
        { asset: "ETH", available: "0.00000000", reserved: "0.00000000" },
        { asset: "USD", available: "1000.00000000", reserved: "0.00000000" },
      ],
    });
  });

  it("requires an access token", async () => {
    const response = await app.inject({ method: "GET", url: "/balances" });

    expect(response.statusCode).toBe(401);
  });
});
