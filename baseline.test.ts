import { beforeAll, describe, expect, it } from "vitest";
import { baselinePolicy, quotes } from "./baseline.ts";
import { ApiClient } from "./client.ts";
import { type PolicySession, runEpisode } from "./evals.ts";
import { useTestServer } from "./testing.ts";

const { app, testMarket, uniqueEmail } = useTestServer();
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
    // A bid and an ask 100 USD either side of the fleet's 70,000, past the maker's outermost
    // quote and any noise limit, and deeper than the noise flow can take in an episode. The
    // policy only quotes when both sides have a best price, and the maker requotes by
    // cancelling every quote before placing new ones: without these, a step that reads the book
    // in that gap finds a side empty and quotes nothing, more often the slower the machine.
    const backstop = new ApiClient(baseUrl, uniqueEmail("baseline-test"), "baseline-test-password");
    await backstop.signIn();
    const btcUsd = await backstop.market(symbol);
    const whole = (amount: number) => BigInt(amount) * 100_000_000n;
    await backstop.deposit("USD", whole(69_900), 8);
    await backstop.deposit("BTC", whole(1), 8);
    for (const [side, price] of [
      ["buy", whole(69_900)],
      ["sell", whole(70_100)],
    ] as const) {
      const placed = await backstop.place(btcUsd, {
        type: "limit",
        side,
        price,
        quantity: whole(1),
      });
      expect(placed).toMatchObject({ ok: true, status: "open" });
    }

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
