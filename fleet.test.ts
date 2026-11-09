import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AgentRunner, type Logger } from "./bots.ts";
import { ApiClient } from "./client.ts";
import { defaultFleet, NOISE_TRADERS_PER_MARKET, waitForApi } from "./fleet.ts";
import { useTestServer } from "./testing.ts";

const { app, uniqueEmail, testMarket } = useTestServer();
const PASSWORD = "fleet-test-password";
let baseUrl: string;

beforeAll(async () => {
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (address === null || typeof address === "string") {
    throw new Error("server has no port");
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
});

describe("defaultFleet", () => {
  it("names one maker and the noise traders per market, each with its own account", () => {
    const fleet = defaultFleet();

    expect(fleet.map((spec) => spec.name)).toEqual([
      "btc-usd-maker",
      "btc-usd-noise-1",
      "btc-usd-noise-2",
      "btc-usd-noise-3",
      "eth-usd-maker",
      "eth-usd-noise-1",
      "eth-usd-noise-2",
      "eth-usd-noise-3",
    ]);
    expect(new Set(fleet.map((spec) => spec.email)).size).toBe(fleet.length);
    expect(fleet[0]?.email).toBe("btc-usd-maker@bots.slipstream.local");
  });

  const runner = () => {
    const events: { event: string; fields: Record<string, unknown> }[] = [];
    const log: Logger = (event, fields = {}) => events.push({ event, fields });
    return { events, runner: new AgentRunner({ baseUrl, password: PASSWORD, log }) };
  };
  const started: AgentRunner[] = [];
  afterAll(() => Promise.all(started.map((r) => r.stopAll())));

  it("trades on both markets with every order on the grid, and stops leaving nothing resting", async () => {
    const { events, runner: fleetRunner } = runner();
    started.push(fleetRunner);
    const emails = new Map<string, string>();
    // The fleet as it ships, limits included, on test markets with the same grids.
    const markets = new Map<string, string>();
    for (const template of ["BTC-USD", "ETH-USD"] as const) {
      markets.set(template, (await testMarket(template)).symbol);
    }
    const fleet = defaultFleet((name) => {
      const email = uniqueEmail(`fleet-test-${name}`);
      emails.set(name, email);
      return email;
    }).map((spec) => ({ ...spec, market: markets.get(spec.market) ?? spec.market }));
    for (const spec of fleet) {
      await fleetRunner.start(spec);
    }
    const makers = [
      ["btc-usd-maker", "BTC", 2_00000000n],
      ["eth-usd-maker", "ETH", 40_00000000n],
    ] as const;
    const makerApi = new Map<string, ApiClient>();
    for (const [name] of makers) {
      const api = new ApiClient(baseUrl, emails.get(name)!, PASSWORD);
      await api.signIn();
      makerApi.set(name, api);
    }
    // A maker has traded once its base, resting orders included, is no longer what it was
    // funded with. How many ticks that takes depends on when the noise traders cross its
    // quotes, so the test waits for it, not for a fixed number of ticks.
    const makerTraded = async ([name, base, funded]: (typeof makers)[number]) => {
      const held = (await makerApi.get(name)!.balances()).get(base);
      return held !== undefined && held.available + held.reserved !== funded;
    };
    const deadline = Date.now() + 20_000;
    for (;;) {
      const ticked = fleetRunner.agents.every((agent) => agent.ticks >= 3);
      const traded = (await Promise.all(makers.map(makerTraded))).every(Boolean);
      if ((ticked && traded) || Date.now() >= deadline) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    await fleetRunner.stopAll();

    for (const agent of fleetRunner.agents) {
      expect(agent.ticks).toBeGreaterThanOrEqual(3);
      // A malformed or off-grid order is a 400, which fails the tick.
      expect({ agent: agent.name, failed: agent.failedTicks }).toEqual({
        agent: agent.name,
        failed: 0,
      });
      expect(agent.riskRefusals).toBe(0);
      expect(agent.status).toBe("stopped");
    }
    expect(events.filter((e) => e.event === "agent_killed")).toEqual([]);

    // Both makers traded: each holds a different amount of its base than it was funded with.
    for (const [name, base, funded] of makers) {
      const held = (await makerApi.get(name)!.balances()).get(base);
      expect({ name, traded: held?.available !== funded }).toEqual({ name, traded: true });
      expect(held?.reserved).toBe(0n);
    }
    expect(fleetRunner.agents.length).toBe(2 * (1 + NOISE_TRADERS_PER_MARKET));
  }, 45_000);
});

describe("waitForApi", () => {
  // A stand-in API whose /health answers with each given status in turn, then the last one.
  async function healthServer(...statuses: number[]): Promise<[Server, string]> {
    const server = createServer((_request, response) => {
      const status = statuses.length > 1 ? statuses.shift() : statuses[0];
      response.writeHead(status ?? 500).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("server has no port");
    }
    return [server, `http://127.0.0.1:${address.port}`];
  }

  it("returns at once when the API is healthy", async () => {
    const waits: unknown[] = [];
    await waitForApi(baseUrl, { log: (_event, fields) => waits.push(fields) });
    expect(waits).toEqual([]);
  });

  it("retries with doubling delays until /health answers 200", async () => {
    const [server, url] = await healthServer(503, 503, 503, 200);
    const waits: Record<string, unknown>[] = [];
    try {
      await waitForApi(url, {
        firstDelayMs: 10,
        maxDelayMs: 25,
        log: (_event, fields = {}) => waits.push(fields),
      });
    } finally {
      server.close();
    }
    expect(waits).toEqual([
      { attempt: 1, outcome: "status 503", retryInMs: 10 },
      { attempt: 2, outcome: "status 503", retryInMs: 20 },
      { attempt: 3, outcome: "status 503", retryInMs: 25 },
    ]);
  });

  it("gives up with the last failure once the timeout has passed", async () => {
    // A port that was just free: nothing listens on it, so every attempt is refused.
    const [server, url] = await healthServer(200);
    await new Promise((resolve) => server.close(resolve));
    await expect(
      waitForApi(url, { timeoutMs: 200, firstDelayMs: 20, maxDelayMs: 50, log: () => {} }),
    ).rejects.toThrow(`API at ${url} not healthy after 200 ms: TypeError: fetch failed`);
  });
});
