// The default bot fleet: on each market one market maker and three noise traders, enough to
// keep the book two-sided and trades printing. `npm run bots` registers and funds every agent
// on first run, signs them back in on later runs, and stops them cleanly on Ctrl-C.

import { setTimeout as sleep } from "node:timers/promises";
import { type AgentLimits, AgentRunner, type AgentSpec, jsonLog, type Logger } from "./bots.ts";
import { parseBotConfig } from "./config.ts";
import { parseAmount } from "./money.ts";
import { marketMaker, noiseTrader } from "./strategies.ts";

// USD, BTC and ETH all have scale 8 (migration 0005); a test checks every number below sits on
// its market's grid, so a change to the seed shows up there.
const SCALE = 8;

function units(decimal: string): bigint {
  const parsed = parseAmount(decimal, SCALE);
  if (!parsed.ok) {
    throw new Error(`bad fleet amount ${decimal}: ${parsed.reason}`);
  }
  return parsed.units;
}

type MarketPlan = {
  symbol: string;
  base: string;
  // Where prices start if the market has never traded.
  referencePrice: string;
  // The maker's base inventory target and its funding around it.
  makerBase: string;
  makerQuote: string;
  noiseBase: string;
  noiseQuote: string;
  // One quote's size, and the noise traders' smallest-to-largest order.
  quoteQuantity: string;
  // In ticks of 0.01 USD.
  halfSpreadTicks: number;
  levelSpacingTicks: number;
  noiseOffsetTicks: number;
  noiseMaxExtraSteps: number;
};

const PLANS: MarketPlan[] = [
  {
    symbol: "BTC-USD",
    base: "BTC",
    referencePrice: "70000",
    makerBase: "2",
    makerQuote: "300000",
    noiseBase: "0.5",
    noiseQuote: "50000",
    quoteQuantity: "0.01",
    halfSpreadTicks: 500,
    levelSpacingTicks: 300,
    noiseOffsetTicks: 1500,
    // 0.0001 to 0.01 BTC.
    noiseMaxExtraSteps: 99,
  },
  {
    symbol: "ETH-USD",
    base: "ETH",
    referencePrice: "3000",
    makerBase: "40",
    makerQuote: "300000",
    noiseBase: "10",
    noiseQuote: "50000",
    quoteQuantity: "0.2",
    halfSpreadTicks: 30,
    levelSpacingTicks: 20,
    noiseOffsetTicks: 100,
    // 0.001 to 0.2 ETH.
    noiseMaxExtraSteps: 199,
  },
];

export const NOISE_TRADERS_PER_MARKET = 3;

// Each agent's account email from its name. Tests pass their own so they get fresh accounts.
export function defaultFleet(
  email: (name: string) => string = (name) => `${name}@bots.slipstream.local`,
): AgentSpec[] {
  return PLANS.flatMap((plan) => {
    const prefix = plan.symbol.toLowerCase();
    const quote = units(plan.quoteQuantity);
    const makerBase = units(plan.makerBase);
    const noiseBase = units(plan.noiseBase);
    // The maker's own caps: full at a quarter of its base either way, skewing up to the width
    // of its spread. Its hard limits sit outside those, so they only trip on a bug.
    const maker: AgentSpec = {
      name: `${prefix}-maker`,
      email: email(`${prefix}-maker`),
      market: plan.symbol,
      funding: { [plan.base]: plan.makerBase, USD: plan.makerQuote },
      intervalMs: 1000,
      strategy: marketMaker({
        referencePrice: units(plan.referencePrice),
        halfSpreadTicks: plan.halfSpreadTicks,
        levels: 5,
        levelSpacingTicks: plan.levelSpacingTicks,
        quoteQuantity: quote,
        targetInventory: makerBase,
        maxInventory: makerBase / 4n,
        maxSkewTicks: 2 * plan.halfSpreadTicks,
      }),
      limits: {
        maxOrderQuantity: quote,
        maxOpenOrders: 20,
        maxPosition: makerBase / 2n,
        maxLoss: units("20000"),
        maxFailedTicks: 30,
      },
    };
    const noiseLimits: AgentLimits = {
      maxOrderQuantity: quote,
      maxOpenOrders: 10,
      maxPosition: noiseBase,
      maxLoss: units("20000"),
      maxFailedTicks: 30,
    };
    const noise = Array.from({ length: NOISE_TRADERS_PER_MARKET }, (_, i): AgentSpec => {
      const name = `${prefix}-noise-${i + 1}`;
      return {
        name,
        email: email(name),
        market: plan.symbol,
        funding: { [plan.base]: plan.noiseBase, USD: plan.noiseQuote },
        intervalMs: 1500,
        strategy: noiseTrader({
          referencePrice: units(plan.referencePrice),
          limitShare: 0.4,
          maxOffsetTicks: plan.noiseOffsetTicks,
          maxExtraSteps: plan.noiseMaxExtraSteps,
          maxOpenOrders: 5,
        }),
        limits: noiseLimits,
      };
    });
    return [maker, ...noise];
  });
}

export type WaitOptions = {
  // How long to keep trying before giving up, counted from the first attempt.
  timeoutMs: number;
  // The wait after the first failure; each later wait doubles, up to maxDelayMs.
  firstDelayMs: number;
  maxDelayMs: number;
  log: Logger;
};

const WAIT_FOR_API: WaitOptions = {
  timeoutMs: 60_000,
  firstDelayMs: 250,
  maxDelayMs: 5_000,
  log: jsonLog,
};

// Resolves once the API's /health answers 200. The API listens only after it has rebuilt
// every book, so a 200 means it takes orders. A rollout restarts the API and the fleet
// together; without this wait the fleet's first sign-in fails while the API replays, the
// process exits and the pod restarts. Doubling delays keep a long replay from being hammered.
export async function waitForApi(
  baseUrl: string,
  options: Partial<WaitOptions> = {},
): Promise<void> {
  const { timeoutMs, firstDelayMs, maxDelayMs, log } = { ...WAIT_FOR_API, ...options };
  const deadline = Date.now() + timeoutMs;
  const health = new URL("/health", baseUrl);
  let delay = firstDelayMs;
  for (let attempt = 1; ; attempt += 1) {
    let outcome: string;
    try {
      const reply = await fetch(health, { signal: AbortSignal.timeout(2_000) });
      if (reply.ok) {
        return;
      }
      await reply.body?.cancel();
      outcome = `status ${reply.status}`;
    } catch (error) {
      outcome = String(error);
    }
    const left = deadline - Date.now();
    if (left <= 0) {
      throw new Error(`API at ${baseUrl} not healthy after ${timeoutMs} ms: ${outcome}`);
    }
    const wait = Math.min(delay, left);
    log("api_waiting", { attempt, outcome, retryInMs: wait });
    await sleep(wait);
    delay = Math.min(delay * 2, maxDelayMs);
  }
}

async function runFleet(): Promise<void> {
  const config = parseBotConfig(process.env);
  const runner = new AgentRunner({
    baseUrl: config.BOT_API_URL,
    password: config.BOT_PASSWORD,
    ...(config.BOT_SEED === undefined ? {} : { seed: config.BOT_SEED }),
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      jsonLog("fleet_stopping", { signal });
      runner.stopAll().then(
        () => process.exit(0),
        (error: unknown) => {
          jsonLog("fleet_stop_failed", { error: String(error) });
          process.exit(1);
        },
      );
    });
  }

  await waitForApi(config.BOT_API_URL);
  try {
    for (const spec of defaultFleet()) {
      await runner.start(spec);
    }
  } catch (error) {
    // Leave nothing resting from the agents that did start.
    await runner.stopAll();
    throw error;
  }
  jsonLog("fleet_started", {
    agents: runner.agents.length,
    api: config.BOT_API_URL,
    seed: config.BOT_SEED ?? null,
  });
}

if (import.meta.main) {
  try {
    await runFleet();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
