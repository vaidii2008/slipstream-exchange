import { beforeAll, describe, expect, it } from "vitest";
import { baselinePolicy, quotes } from "./baseline.ts";
import { ApiClient } from "./client.ts";
import { type PolicySession, runEpisode } from "./evals.ts";
import { useTestServer } from "./testing.ts";

const { app, testMarket } = useTestServer();
let baseUrl: string;

beforeAll(async () => {
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (address === null || typeof address === "string") {
    throw new Error("server has no port");
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
});

describe("quotes", () => {
  it("steps one tick inside the best bid and ask", () => {
    expect(quotes("70000.00000000", "70010.00000000", "0.01000000")).toEqual({
      bid: "70000.01000000",
      ask: "70009.99000000",
    });
  });

  it("joins the best prices when the spread is too narrow to step inside", () => {
    expect(quotes("70000.00000000", "70000.02000000", "0.01000000")).toEqual({
      bid: "70000.00000000",
      ask: "70000.02000000",
    });
    expect(quotes("70000.00000000", "70000.01000000", "0.01000000")).toEqual({
      bid: "70000.00000000",
      ask: "70000.01000000",
    });
  });
});

describe("baselinePolicy", () => {
  it("requotes both sides each step until the deadline and leaves nothing resting", async () => {
    const symbol = (await testMarket("BTC-USD")).symbol;
    const baseline = baselinePolicy({ stepMs: 1000, quantity: "0.01" });
    let handed: PolicySession | undefined;

    const episode = await runEpisode({
      apiUrl: baseUrl,
      symbol,
      seed: 5,
      policy: {
        name: baseline.name,
        run: (session) => {
          handed = session;
          return baseline.run(session);
        },
      },
      horizonMs: 4000,
      warmupTrades: 2,
      funding: { base: "0.1", quote: "10000" },
    });

    const { run } = episode;
    expect(run).toMatchObject({ stopReason: "deadline", costUsd: 0 });
    expect(run.turns).toBeGreaterThanOrEqual(2);
    const places = run.toolCalls.filter((call) => call.name === "place_order");
    // Two quotes a step, each one accepted (or refused by a risk limit, never invalid).
    expect(places).toHaveLength(2 * run.turns);
    expect(places.filter((call) => call.isError)).toEqual(
      places.filter((call) => call.isError && call.error?.includes("risk_")),
    );
    // Every step after the first found its last quotes resting, or filled, and cancelled them.
    expect(run.toolCalls.some((call) => call.name === "cancel_order")).toBe(true);

    // Closing the MCP server at the deadline cancelled the last quotes.
    if (handed === undefined) {
      throw new Error("the policy never ran");
    }
    const account = new ApiClient(baseUrl, handed.email, handed.password);
    await account.signIn();
    expect(await account.openOrders(await account.market(symbol))).toEqual([]);
  }, 30_000);
});
