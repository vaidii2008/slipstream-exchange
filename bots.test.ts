import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AgentRunner, ApiClient, type AgentContext, type Logger, type Strategy } from "./bots.ts";
import { useTestServer } from "./testing.ts";

const { app, uniqueEmail } = useTestServer();
const PASSWORD = "bots-test-password";
let baseUrl: string;

beforeAll(async () => {
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (address === null || typeof address === "string") {
    throw new Error("server has no port");
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
});

const quiet: Logger = () => {};

// Resolves once `check` passes, polling every 10 ms, so a test waits for ticks to happen
// rather than for a fixed time.
async function until(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error("condition not met in time");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// A strategy that rests one bid far below any real price on its first tick and only counts
// after that.
function restingBid() {
  const seen: AgentContext[] = [];
  const strategy: Strategy = {
    async tick(context) {
      if (seen.length === 0) {
        await context.api.place(context.market, {
          type: "limit",
          side: "buy",
          price: 1_00000000n,
          quantity: context.market.minQuantity,
        });
      }
      seen.push(context);
    },
  };
  return { strategy, seen };
}

describe("AgentRunner", () => {
  const runners: AgentRunner[] = [];
  afterAll(async () => {
    await Promise.all(runners.map((runner) => runner.stopAll()));
  });
  const runner = () => {
    const created = new AgentRunner({ baseUrl, password: PASSWORD, log: quiet });
    runners.push(created);
    return created;
  };

  it("registers the agent, funds it and ticks it on its interval", async () => {
    const email = uniqueEmail("bots-test");
    const { strategy, seen } = restingBid();

    const agent = await runner().start({
      name: "first",
      email,
      market: "BTC-USD",
      funding: { USD: "1000", BTC: "0.5" },
      intervalMs: 20,
      strategy,
    });
    await until(() => seen.length >= 3);

    expect(agent.status).toBe("running");
    expect(seen[0]?.market).toMatchObject({
      symbol: "BTC-USD",
      baseAsset: "BTC",
      quoteAsset: "USD",
      baseScale: 8,
      quoteScale: 8,
    });
    const api = new ApiClient(baseUrl, email, PASSWORD);
    await api.signIn();
    const balances = await api.balances();
    // The bid reserves its notional: 1 USD × 0.0001 BTC = 0.0001 USD.
    expect(balances.get("USD")).toEqual({ available: 999_99990000n, reserved: 10000n });
    expect(balances.get("BTC")).toEqual({ available: 50000000n, reserved: 0n });
  });

  it("on restart signs in to the same account and tops it up only to the target", async () => {
    const email = uniqueEmail("bots-test");
    const spec = {
      name: "restarted",
      email,
      market: "ETH-USD",
      funding: { USD: "500" },
      intervalMs: 1000,
      strategy: { tick: async () => {} },
    };
    const first = runner();
    await first.start(spec);
    await first.stopAll();

    const api = new ApiClient(baseUrl, email, PASSWORD);
    await api.signIn();
    await api.deposit("USD", 100_00000000n, 8);
    // Spent below target: now 600 USD, more than the 500 target, so no top-up.
    await runner().start(spec);
    expect((await api.balances()).get("USD")?.available).toBe(600_00000000n);
  });

  it("stops after the tick in flight and cancels the agent's resting orders", async () => {
    const email = uniqueEmail("bots-test");
    const { strategy, seen } = restingBid();
    const agent = await runner().start({
      name: "stopping",
      email,
      market: "BTC-USD",
      funding: { USD: "1000" },
      intervalMs: 20,
      strategy,
    });
    await until(() => seen.length >= 1);

    await agent.stop();
    const ticksAtStop = seen.length;
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(agent.status).toBe("stopped");
    expect(seen.length).toBe(ticksAtStop);
    const api = new ApiClient(baseUrl, email, PASSWORD);
    await api.signIn();
    expect(await api.openOrders(seen[0]!.market)).toEqual([]);
    expect((await api.balances()).get("USD")).toEqual({ available: 1000_00000000n, reserved: 0n });
  });

  it("keeps ticking after a tick fails", async () => {
    let calls = 0;
    const agent = await runner().start({
      name: "flaky",
      email: uniqueEmail("bots-test"),
      market: "BTC-USD",
      funding: {},
      intervalMs: 10,
      strategy: {
        tick() {
          calls += 1;
          return calls === 1
            ? Promise.reject(new Error("the API is restarting"))
            : Promise.resolve();
        },
      },
    });
    await until(() => agent.ticks >= 2);

    expect(agent.failedTicks).toBe(1);
  });

  it("refuses funding in an asset the market does not trade", async () => {
    await expect(
      runner().start({
        name: "wrong-asset",
        email: uniqueEmail("bots-test"),
        market: "BTC-USD",
        funding: { ETH: "1" },
        intervalMs: 1000,
        strategy: { tick: async () => {} },
      }),
    ).rejects.toThrow("funding ETH is not traded in BTC-USD");
  });
});
