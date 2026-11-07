import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AgentRunner, ApiClient, type Logger, type MarketInfo } from "./bots.ts";
import { type NoiseOptions, noiseOrder, noiseTrader } from "./strategies.ts";
import { useTestServer } from "./testing.ts";

const { app, uniqueEmail } = useTestServer();
const PASSWORD = "strategies-test-password";
const quiet: Logger = () => {};
let baseUrl: string;

beforeAll(async () => {
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (address === null || typeof address === "string") {
    throw new Error("server has no port");
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
});

// BTC-USD's grid: a 0.01 USD tick and a 0.0001 BTC step and minimum, both at scale 8.
const btcUsd: MarketInfo = {
  symbol: "BTC-USD",
  baseAsset: "BTC",
  quoteAsset: "USD",
  baseScale: 8,
  quoteScale: 8,
  tickSize: 1_000_000n,
  quantityStep: 10_000n,
  minQuantity: 10_000n,
};
const usd = (whole: number) => BigInt(whole) * 100_000_000n;

// Hands out the given numbers in order, so a test states exactly what each draw is.
function scripted(...values: number[]): () => number {
  return () => {
    const next = values.shift();
    if (next === undefined) {
      throw new Error("the strategy drew more random numbers than the test scripted");
    }
    return next;
  };
}

// A small seeded generator (mulberry32) for tests that need many draws.
function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const noise: NoiseOptions = {
  referencePrice: usd(70_000),
  limitShare: 0.5,
  maxOffsetTicks: 10,
  maxExtraSteps: 9,
  maxOpenOrders: 3,
};

describe("noiseOrder", () => {
  it("sends a market order when the draw is at or above the limit share", () => {
    // side, extra steps, limit-or-market.
    expect(noiseOrder(btcUsd, usd(70_000), scripted(0.7, 0.99, 0.5), noise)).toEqual({
      type: "market",
      side: "sell",
      quantity: 10_000n + 9n * 10_000n,
    });
  });

  it("sends a limit up to maxOffsetTicks either side of the last trade", () => {
    // Offsets are drawn from the 21 values -10..10; 0 is the lowest and 0.999 the highest.
    const low = noiseOrder(btcUsd, usd(70_000), scripted(0.1, 0, 0.2, 0), noise);
    const high = noiseOrder(btcUsd, usd(70_000), scripted(0.1, 0, 0.2, 0.999), noise);

    expect(low).toEqual({
      type: "limit",
      side: "buy",
      price: usd(70_000) - 10n * btcUsd.tickSize,
      quantity: 10_000n,
    });
    expect(high).toMatchObject({ price: usd(70_000) + 10n * btcUsd.tickSize });
  });

  it("never prices below one tick", () => {
    const order = noiseOrder(btcUsd, btcUsd.tickSize * 3n, scripted(0.1, 0, 0.2, 0), noise);

    expect(order).toMatchObject({ type: "limit", price: btcUsd.tickSize });
  });

  it("keeps every order on the market's grid and within its bounds", () => {
    const random = seeded(7);
    const orders = Array.from({ length: 2000 }, () =>
      noiseOrder(btcUsd, usd(70_000), random, noise),
    );

    for (const order of orders) {
      expect(order.quantity % btcUsd.quantityStep).toBe(0n);
      expect(order.quantity >= btcUsd.minQuantity).toBe(true);
      expect(order.quantity <= btcUsd.minQuantity + 9n * btcUsd.quantityStep).toBe(true);
      if (order.type === "limit") {
        expect(order.price % btcUsd.tickSize).toBe(0n);
        const offset = order.price - usd(70_000);
        expect(offset >= -10n * btcUsd.tickSize && offset <= 10n * btcUsd.tickSize).toBe(true);
      }
    }
    // Over 2,000 draws every kind of order turns up.
    for (const kind of ["limit:buy", "limit:sell", "market:buy", "market:sell"]) {
      expect(orders.some((order) => `${order.type}:${order.side}` === kind)).toBe(true);
    }
  });
});

describe("noiseTrader", () => {
  const runners: AgentRunner[] = [];
  afterAll(() => Promise.all(runners.map((runner) => runner.stopAll())));
  const runner = () => {
    const created = new AgentRunner({ baseUrl, password: PASSWORD, log: quiet, random: seeded(1) });
    runners.push(created);
    return created;
  };

  it("trades against resting liquidity and keeps at most maxOpenOrders resting", async () => {
    // A liquidity provider with a bid and an ask either side of 3,000 on ETH-USD.
    const provider = new ApiClient(baseUrl, uniqueEmail("strategies-test"), PASSWORD);
    await provider.signIn();
    const ethUsd = await provider.market("ETH-USD");
    await provider.deposit("USD", usd(100_000), 8);
    await provider.deposit("ETH", 20n * 100_000_000n, 8);
    for (const [side, price] of [
      ["buy", usd(2_990)],
      ["sell", usd(3_010)],
    ] as const) {
      await provider.place(ethUsd, { type: "limit", side, price, quantity: 10n * 100_000_000n });
    }

    const email = uniqueEmail("strategies-test");
    const agent = await runner().start({
      name: "noise",
      email,
      market: "ETH-USD",
      funding: { USD: "10000", ETH: "2" },
      intervalMs: 10,
      strategy: noiseTrader({ ...noise, referencePrice: usd(3_000), limitShare: 0.3 }),
    });
    const api = new ApiClient(baseUrl, email, PASSWORD);
    await api.signIn();

    let mostOpen = 0;
    const deadline = Date.now() + 5000;
    while (agent.ticks < 30 && Date.now() < deadline) {
      mostOpen = Math.max(mostOpen, (await api.openOrders(ethUsd)).length);
    }
    await agent.stop();

    expect(agent.ticks).toBeGreaterThanOrEqual(30);
    expect(agent.failedTicks).toBe(0);
    expect((await api.balances()).get("ETH")?.available).not.toBe(2n * 100_000_000n);
    expect(mostOpen).toBeLessThanOrEqual(3);
    expect(await api.openOrders(ethUsd)).toEqual([]);
  });
});
