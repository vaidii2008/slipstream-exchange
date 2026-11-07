import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AgentRunner, ApiClient, type Logger } from "./bots.ts";
import { defaultFleet, NOISE_TRADERS_PER_MARKET } from "./fleet.ts";
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
    const deadline = Date.now() + 15_000;
    while (fleetRunner.agents.some((agent) => agent.ticks < 3) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
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
    for (const [name, base, funded] of [
      ["btc-usd-maker", "BTC", 2_00000000n],
      ["eth-usd-maker", "ETH", 40_00000000n],
    ] as const) {
      const api = new ApiClient(baseUrl, emails.get(name)!, PASSWORD);
      await api.signIn();
      const held = (await api.balances()).get(base);
      expect({ name, traded: held?.available !== funded }).toEqual({ name, traded: true });
      expect(held?.reserved).toBe(0n);
    }
    expect(fleetRunner.agents.length).toBe(2 * (1 + NOISE_TRADERS_PER_MARKET));
  }, 30_000);
});
