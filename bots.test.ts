import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AgentRunner,
  ApiClient,
  type AgentContext,
  type AgentSpec,
  type Logger,
  type RiskLimits,
  markFrom,
  type Strategy,
} from "./bots.ts";
import { useTestServer } from "./testing.ts";

const { app, uniqueEmail, testMarket } = useTestServer();
const PASSWORD = "bots-test-password";
let baseUrl: string;

// This file's own markets, which only its server's exchange trades.
let btc: string;
let eth: string;

beforeAll(async () => {
  [btc, eth] = await Promise.all([
    testMarket("BTC-USD").then((market) => market.symbol),
    testMarket("ETH-USD").then((market) => market.symbol),
  ]);
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (address === null || typeof address === "string") {
    throw new Error("server has no port");
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
});

const quiet: Logger = () => {};
// Limits no test here comes near, for tests about something else.
const loose: RiskLimits = {
  maxOrderQuantity: 10n ** 12n,
  maxOpenOrders: 100,
  maxPosition: 10n ** 12n,
  maxLoss: 10n ** 15n,
  maxFailedTicks: 1000,
};

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
      market: btc,
      funding: { USD: "1000", BTC: "0.5" },
      intervalMs: 20,
      limits: loose,
      strategy,
    });
    await until(() => seen.length >= 3);

    expect(agent.status).toBe("running");
    expect(seen[0]?.market).toMatchObject({
      symbol: btc,
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
      market: eth,
      funding: { USD: "500" },
      intervalMs: 1000,
      limits: loose,
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
      market: btc,
      funding: { USD: "1000" },
      intervalMs: 20,
      limits: loose,
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
      market: btc,
      funding: {},
      intervalMs: 10,
      limits: loose,
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
        market: btc,
        funding: { ETH: "1" },
        intervalMs: 1000,
        limits: loose,
        strategy: { tick: async () => {} },
      }),
    ).rejects.toThrow(`funding ETH is not traded in ${btc}`);
  });
});

describe("markFrom", () => {
  it("is undefined before the first trade", () => {
    expect(markFrom([])).toBeUndefined();
  });

  it("is the newest price while there are fewer than twenty trades", () => {
    expect(markFrom([5n, 100n, 100n])).toBe(5n);
  });

  it("is the median of the newest twenty, ignoring one outlier and anything older", () => {
    const prices = [1n, ...Array<bigint>(19).fill(70n), 999n];
    expect(markFrom(prices)).toBe(70n);
  });

  it("averages the two middle prices, rounded down", () => {
    // Ten at 10 and ten at 13: the middle two are 10 and 13.
    expect(markFrom([...Array<bigint>(10).fill(13n), ...Array<bigint>(10).fill(10n)])).toBe(11n);
  });
});

describe("risk limits", () => {
  const runners: AgentRunner[] = [];
  afterAll(async () => {
    await Promise.all(runners.map((runner) => runner.stopAll()));
  });

  // Equity is measured at prices the test sets: `prices` are the recent trades, newest first.
  // One price is fewer than the mark window, so the mark is that price.
  let price = 70_000_00000000n;
  let prices: bigint[] | undefined;
  class PricedClient extends ApiClient {
    override recentPrices(): Promise<bigint[]> {
      return Promise.resolve(prices ?? [price]);
    }
  }
  const runner = () => {
    const created = new AgentRunner({
      baseUrl,
      password: PASSWORD,
      log: quiet,
      client: (url, email, password) => new PricedClient(url, email, password),
    });
    runners.push(created);
    return created;
  };
  const limits: RiskLimits = {
    maxOrderQuantity: 1_000_000n,
    maxOpenOrders: 2,
    maxPosition: 1_500_000n,
    maxLoss: 500_00000000n,
    maxFailedTicks: 3,
  };
  const idle = { tick: () => Promise.resolve() };
  // Funded with 10,000 USD and 0.1 BTC; ticks are driven by the test unless it says otherwise.
  const start = (overrides: Partial<AgentSpec> = {}) =>
    runner().start({
      name: "risky",
      email: uniqueEmail("bots-test"),
      market: btc,
      funding: { USD: "10000", BTC: "0.1" },
      intervalMs: 600_000,
      strategy: idle,
      limits,
      ...overrides,
    });
  const bid = (quantity: bigint) => ({
    type: "limit" as const,
    side: "buy" as const,
    price: 1_00000000n,
    quantity,
  });

  it("refuses an order larger than maxOrderQuantity without sending it", async () => {
    const agent = await start();
    const { api, market } = agent.context;

    await expect(api.place(market, bid(1_010_000n))).resolves.toEqual({
      ok: false,
      status: 0,
      error: "risk_max_order_quantity",
    });
    expect(await api.openOrders(market)).toEqual([]);
    await expect(api.place(market, bid(1_000_000n))).resolves.toMatchObject({ ok: true });
    expect(agent.riskRefusals).toBe(1);
  });

  it("refuses a third resting order at maxOpenOrders 2", async () => {
    const { context } = await start();
    const { api, market } = context;

    await api.place(market, bid(10_000n));
    await api.place(market, bid(10_000n));

    await expect(api.place(market, bid(10_000n))).resolves.toMatchObject({
      error: "risk_max_open_orders",
    });
  });

  it("counts resting orders as filled when checking maxPosition", async () => {
    const { context } = await start({ limits: { ...limits, maxOpenOrders: 10 } });
    const { api, market } = context;

    // 0.01 BTC resting bid, then 0.006 more would make 0.016 BTC long if both filled.
    await api.place(market, bid(1_000_000n));
    await expect(api.place(market, bid(600_000n))).resolves.toMatchObject({
      error: "risk_max_position",
    });
    await expect(api.place(market, bid(500_000n))).resolves.toMatchObject({ ok: true });
    // Selling only moves the other way from start, by 0.01 BTC: allowed.
    await expect(
      api.place(market, {
        type: "limit",
        side: "sell",
        price: 1_000_000_00000000n,
        quantity: 1_000_000n,
      }),
    ).resolves.toMatchObject({ ok: true });
  });

  it("kills the agent and cancels its orders when equity falls past maxLoss", async () => {
    price = 70_000_00000000n;
    let ticks = 0;
    const agent = await start({
      intervalMs: 10,
      strategy: {
        async tick({ api, market }: AgentContext) {
          ticks += 1;
          if (ticks === 1) {
            await api.place(market, bid(10_000n));
          }
        },
      },
    });
    await until(() => ticks >= 2);

    // 0.1 BTC from 70,000 to 64,000 is 600 USD of equity gone, past the 500 limit.
    price = 64_000_00000000n;
    await until(() => agent.status === "killed");
    const ticksAtKill = ticks;
    await new Promise((resolve) => setTimeout(resolve, 50));
    price = 70_000_00000000n;

    expect(agent.killReason).toBe("lost 60000000000 quote minor units, limit 50000000000");
    expect(ticks).toBe(ticksAtKill);
    const { api, market } = agent.context;
    expect(await api.openOrders(market)).toEqual([]);
    await expect(api.place(market, bid(10_000n))).resolves.toMatchObject({
      error: "risk_killed",
    });
  });

  it("does not kill a maker when one trade in the last twenty is off-price", async () => {
    const steady = Array<bigint>(20).fill(70_000_00000000n);
    prices = steady;
    let ticks = 0;
    try {
      const agent = await start({
        intervalMs: 10,
        strategy: {
          tick() {
            ticks += 1;
            return Promise.resolve();
          },
        },
      });
      await until(() => ticks >= 2);

      // A new trade at 60,000 on top of nineteen at 70,000. Valued at the last trade, 0.1 BTC
      // would be worth 1,000 USD less, past the 500 limit; at the median it is worth the same.
      prices = [60_000_00000000n, ...steady.slice(0, 19)];
      const before = ticks;
      await until(() => ticks >= before + 5);

      expect(agent.status).toBe("running");
      expect(agent.killReason).toBeUndefined();
      await agent.stop();
    } finally {
      prices = undefined;
    }
  });

  it("kills the agent after maxFailedTicks failures in a row, not in total", async () => {
    // fail, fail, succeed, then fail until killed: killed on the third in a row.
    const script = [false, false, true];
    let calls = 0;
    const agent = await start({
      intervalMs: 5,
      strategy: {
        tick() {
          calls += 1;
          return (script[calls - 1] ?? false)
            ? Promise.resolve()
            : Promise.reject(new Error("the API is down"));
        },
      },
    });
    await until(() => agent.status === "killed");

    expect(calls).toBe(6);
    expect(agent.failedTicks).toBe(5);
    expect(agent.killReason).toBe("3 failed ticks in a row");
  });

  it("kills on demand, after the tick in flight, and leaves nothing resting", async () => {
    let release: () => void = () => {};
    let entered = false;
    const agent = await start({
      intervalMs: 5,
      strategy: {
        async tick({ api, market }: AgentContext) {
          entered = true;
          await new Promise<void>((resolve) => (release = resolve));
          // Still in the tick when the kill switch trips: this order must not go out.
          await api.place(market, bid(10_000n));
        },
      },
    });
    const { api, market } = agent.context;
    await api.place(market, bid(10_000n));
    await until(() => entered);

    const killing = agent.kill("operator");
    release();
    await killing;

    expect(agent.status).toBe("killed");
    expect(agent.killReason).toBe("operator");
    expect(agent.riskRefusals).toBe(1);
    expect(await api.openOrders(market)).toEqual([]);
  });
});
