// Agent evals. An episode puts one trading policy (the LLM agent, or later a rule-based
// baseline) on a market the seeded bot fleet is already trading, for a fixed time, from a
// freshly funded account, and records what it did and what its equity did.
//
// Each episode runs on a stack of its own: a Postgres and Redis under the Compose project
// slipstream-eval, wiped and started again before every episode, and an API process on that
// stack. Nothing an episode does can reach the dev database, and no episode starts with a book,
// trades or accounts left from another.

import Anthropic from "@anthropic-ai/sdk";
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { parseArgs, promisify } from "node:util";
import {
  type CreateMessage,
  connectMcp,
  RATES,
  runAgent,
  type StopReason,
  type TokenTotals,
  type ToolCall,
  taskPrompt,
} from "./agent.ts";
import { baselinePolicy } from "./baseline.ts";
import { AgentRunner, type Logger } from "./bots.ts";
import { ApiClient, type Fill, MARK_WINDOW, type MarketInfo, units } from "./client.ts";
import { parseEvalConfig } from "./config.ts";
import { defaultFleet } from "./fleet.ts";
import { formatAmount } from "./money.ts";
import { valueAt } from "./risk.ts";
import { scoreEpisode, summarize, summaryTable } from "./score.ts";

// What a policy is handed: an account that already exists and is funded, and when to stop.
export type PolicySession = {
  apiUrl: string;
  symbol: string;
  email: string;
  password: string;
  deadline: number;
};

// What a policy did. A rule-based policy has no tokens and no cost.
export type PolicyRun = {
  stopReason: StopReason;
  turns: number;
  toolCalls: ToolCall[];
  tokens: TokenTotals;
  costUsd: number;
};

export type Policy = { name: string; run(session: PolicySession): Promise<PolicyRun> };

export type EpisodeOptions = {
  apiUrl: string;
  symbol: string;
  seed: number;
  policy: Policy;
  // From the policy's start to the second equity reading, whenever the policy itself stops.
  horizonMs: number;
  // Trades the fleet must print before the policy starts, so equity has a mark to value at.
  warmupTrades: number;
  // What the policy's account starts with, as decimal strings.
  funding: { base: string; quote: string };
  log?: (line: string) => void;
};

export type Episode = {
  seed: number;
  policy: string;
  email: string;
  // Quote minor units: the quote balance plus base valued at the mark (see risk.ts equity).
  startEquity: bigint;
  endEquity: bigint;
  // The marks those two equities used, and the base the account started with, so a score can
  // say what holding that base and doing nothing would have made over the same stretch.
  startMark: bigint;
  endMark: bigint;
  startBase: bigint;
  baseScale: number;
  // Every trade the account made, read at the horizon.
  fills: Fill[];
  // The quote asset's scale, to print the equities.
  quoteScale: number;
  run: PolicyRun;
  durationMs: number;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Only the bots' own failures are worth seeing in an eval's output.
const fleetLog: Logger = (event, fields = {}) => {
  if (event === "agent_killed" || event.endsWith("_failed")) {
    console.error(JSON.stringify({ event, ...fields }));
  }
};

async function waitForTrades(api: ApiClient, symbol: string, count: number): Promise<void> {
  const market = await api.market(symbol);
  const deadline = Date.now() + 60_000;
  while ((await api.recentTrades(market, count)).length < count) {
    if (Date.now() > deadline) {
      throw new Error(`the fleet printed fewer than ${count} trades in 60 s`);
    }
    await sleep(250);
  }
}

// Equity and the mark it was valued at, from one read of each.
async function valuation(
  account: ApiClient,
  market: MarketInfo,
): Promise<{ equity: bigint; mark: bigint }> {
  const [balances, mark] = await Promise.all([account.balances(), account.markPrice(market)]);
  if (mark === undefined) {
    throw new Error("no trades to value the account at");
  }
  return { equity: valueAt(balances, mark, market), mark };
}

export async function runEpisode(options: EpisodeOptions): Promise<Episode> {
  const { apiUrl, symbol, seed, policy } = options;
  const log = options.log ?? (() => {});
  const started = Date.now();

  // The fleet for this market only, seeded, with a password of its own.
  const fleet = new AgentRunner({
    baseUrl: apiUrl,
    password: randomBytes(12).toString("hex"),
    seed,
    log: fleetLog,
  });
  // A fresh stack has no accounts, but a test's database keeps them, so every episode's
  // accounts are new ones.
  const id = randomBytes(4).toString("hex");
  const specs = defaultFleet((name) => `${name}-${seed}-${id}@evals.slipstream.local`)
    .filter((spec) => spec.market === "BTC-USD")
    .map((spec) => ({ ...spec, market: symbol }));
  try {
    for (const spec of specs) {
      await fleet.start(spec);
    }

    const email = `${policy.name}-${seed}-${id}@evals.slipstream.local`;
    const password = randomBytes(12).toString("hex");
    const account = new ApiClient(apiUrl, email, password);
    await account.signIn();
    await waitForTrades(account, symbol, options.warmupTrades);
    const market = await account.market(symbol);
    await account.deposit(
      market.baseAsset,
      units(options.funding.base, market.baseScale),
      market.baseScale,
    );
    await account.deposit(
      market.quoteAsset,
      units(options.funding.quote, market.quoteScale),
      market.quoteScale,
    );

    const start = await valuation(account, market);
    const startEquity = start.equity;
    const deadline = Date.now() + options.horizonMs;
    log(
      `episode seed ${seed}, ${policy.name}: start equity ${formatAmount(startEquity, market.quoteScale)}`,
    );
    const run = await policy.run({ apiUrl, symbol, email, password, deadline });
    // Every policy is marked at the same horizon, so one that stops early still carries its
    // position through the same stretch of market as one that trades to the end.
    await sleep(Math.max(0, deadline - Date.now()));
    const end = await valuation(account, market);
    const endEquity = end.equity;
    log(
      `episode seed ${seed}, ${policy.name}: end equity ${formatAmount(endEquity, market.quoteScale)}`,
    );
    return {
      seed,
      policy: policy.name,
      email,
      startEquity,
      endEquity,
      startMark: start.mark,
      endMark: end.mark,
      startBase: units(options.funding.base, market.baseScale),
      baseScale: market.baseScale,
      fills: await account.fills(market),
      quoteScale: market.quoteScale,
      run,
      durationMs: Date.now() - started,
    };
  } finally {
    await fleet.stopAll();
  }
}

// The LLM agent, through the MCP server as a host would run it. Closing the MCP client ends
// the server, which cancels whatever the agent left resting.
export function agentPolicy(options: {
  create: CreateMessage;
  model: string;
  maxTurns: number;
  budgetUsd: number;
  log?: (line: string) => void;
}): Policy {
  return {
    name: "agent",
    async run(session) {
      const mcp = await connectMcp({
        AGENT_API_URL: session.apiUrl,
        AGENT_EMAIL: session.email,
        AGENT_PASSWORD: session.password,
        AGENT_MARKET: session.symbol,
      });
      try {
        const run = await runAgent({
          create: options.create,
          mcp,
          model: options.model,
          task: taskPrompt(options.maxTurns),
          maxTurns: options.maxTurns,
          budgetUsd: options.budgetUsd,
          deadline: session.deadline,
          ...(options.log === undefined ? {} : { log: options.log }),
        });
        return {
          stopReason: run.stopReason,
          turns: run.turns,
          toolCalls: run.toolCalls,
          tokens: run.tokens,
          costUsd: run.costUsd,
        };
      } finally {
        await mcp.close();
      }
    },
  };
}

// The eval stack. Its own Compose project means its own containers and its own volumes; the
// ports keep it clear of the dev stack's 5433, 6380 and 3000.
const EVAL_PROJECT = "slipstream-eval";
const EVAL_POSTGRES_PORT = 5434;
const EVAL_REDIS_PORT = 6381;
const EVAL_API_PORT = 3100;
const run = promisify(execFile);

// Only what docker needs, so the Anthropic key in this process's environment stays here.
function dockerEnv(): Record<string, string> {
  const env: Record<string, string> = {
    SLIPSTREAM_POSTGRES_PORT: String(EVAL_POSTGRES_PORT),
    SLIPSTREAM_REDIS_PORT: String(EVAL_REDIS_PORT),
  };
  for (const name of ["PATH", "HOME", "DOCKER_HOST", "DOCKER_CONTEXT"]) {
    const value = process.env[name];
    if (value !== undefined) {
      env[name] = value;
    }
  }
  return env;
}

async function compose(...args: string[]): Promise<void> {
  await run("docker", ["compose", "-p", EVAL_PROJECT, ...args], {
    cwd: import.meta.dirname,
    env: dockerEnv(),
  });
}

// Removes the eval project's containers and volumes and starts Postgres and Redis again, empty.
// -p names the eval project, never the dev one, so its volumes are the only ones removed.
async function freshStack(): Promise<void> {
  await compose("down", "--volumes", "--remove-orphans");
  await compose("up", "--detach", "--wait", "postgres", "redis");
}

async function removeStack(): Promise<void> {
  await compose("down", "--volumes", "--remove-orphans");
}

type RunningApi = { url: string; stop(): Promise<void> };

// Migrates the fresh database and starts the API on it, as its own process.
async function startApi(): Promise<RunningApi> {
  const env = {
    PATH: process.env.PATH ?? "",
    PORT: String(EVAL_API_PORT),
    DATABASE_URL: `postgres://slipstream:slipstream@127.0.0.1:${EVAL_POSTGRES_PORT}/slipstream`,
    REDIS_URL: `redis://127.0.0.1:${EVAL_REDIS_PORT}`,
    JWT_ACCESS_SECRET: randomBytes(32).toString("hex"),
    LOG_LEVEL: "error",
  };
  await run(process.execPath, ["migrate.ts"], { cwd: import.meta.dirname, env });
  // The API's log lines go to this process's stderr, away from the results on stdout.
  const child: ChildProcess = spawn(process.execPath, ["main.ts"], {
    cwd: import.meta.dirname,
    env,
    stdio: ["ignore", 2, 2],
  });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const url = `http://127.0.0.1:${EVAL_API_PORT}`;
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`the eval API exited with ${child.exitCode}`);
    }
    try {
      if ((await fetch(`${url}/health`)).ok) {
        break;
      }
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) {
      child.kill("SIGKILL");
      throw new Error("the eval API did not become healthy in 30 s");
    }
    await sleep(200);
  }
  return {
    url,
    async stop() {
      child.kill("SIGTERM");
      await exited;
    },
  };
}

// The whole run stops starting agent episodes once it has spent this much on the model.
const RUN_BUDGET_USD = 1;

// How often the baseline requotes: about as often as the agent takes a turn.
const BASELINE_STEP_MS = 3000;

// `npm run eval -- --episodes 2 --turns 8 --seconds 60`
async function main(): Promise<void> {
  const config = parseEvalConfig(process.env);
  if (RATES[config.AGENT_MODEL] === undefined) {
    throw new Error(`no token rates for ${config.AGENT_MODEL}, so its budget cannot be enforced`);
  }
  const { values } = parseArgs({
    options: {
      episodes: { type: "string", default: "2" },
      "first-seed": { type: "string", default: "1" },
      turns: { type: "string", default: "8" },
      seconds: { type: "string", default: "60" },
      "episode-budget": { type: "string", default: "0.1" },
      policies: { type: "string", default: "agent,baseline" },
      out: { type: "string" },
    },
  });
  const episodes = Number(values.episodes);
  const firstSeed = Number(values["first-seed"]);
  const maxTurns = Number(values.turns);
  const seconds = Number(values.seconds);
  const episodeBudget = Number(values["episode-budget"]);
  if (![episodes, maxTurns, seconds, episodeBudget].every((n) => Number.isFinite(n) && n > 0)) {
    throw new Error("--episodes, --turns, --seconds and --episode-budget must be positive");
  }
  if (!Number.isInteger(firstSeed) || firstSeed < 0) {
    throw new Error("--first-seed must be a whole number");
  }
  const policies = values.policies.split(",");
  if (policies.length === 0 || !policies.every((name) => name === "agent" || name === "baseline")) {
    throw new Error("--policies is a comma-separated list of agent and baseline");
  }

  const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
  const create: CreateMessage = (params) => anthropic.messages.create(params);
  const results: Episode[] = [];
  let spent = 0;
  try {
    // Every policy on every seed, each on a stack of its own, so the baseline meets the same
    // seeded fleet the agent did, from the same empty book.
    for (let seed = firstSeed; seed < firstSeed + episodes; seed += 1) {
      for (const name of policies) {
        if (name === "agent" && spent >= RUN_BUDGET_USD) {
          console.error(
            `eval: skipping the agent, $${spent.toFixed(4)} spent of $${RUN_BUDGET_USD}`,
          );
          continue;
        }
        const policy =
          name === "agent"
            ? agentPolicy({
                create,
                model: config.AGENT_MODEL,
                maxTurns,
                budgetUsd: Math.min(episodeBudget, RUN_BUDGET_USD - spent),
                log: (line) => console.error(line),
              })
            : baselinePolicy({ stepMs: BASELINE_STEP_MS, quantity: "0.01" });
        await freshStack();
        const api = await startApi();
        try {
          const episode = await runEpisode({
            apiUrl: api.url,
            symbol: "BTC-USD",
            seed,
            policy,
            horizonMs: seconds * 1000,
            warmupTrades: MARK_WINDOW,
            funding: { base: "0.1", quote: "10000" },
            log: (line) => console.error(line),
          });
          spent += episode.run.costUsd;
          results.push(episode);
        } finally {
          await api.stop();
        }
      }
    }
  } finally {
    await removeStack();
  }

  const scores = results.map(scoreEpisode);
  const summaries = summarize(scores);
  const [first] = results;
  if (first !== undefined) {
    console.error(summaryTable(summaries, first.quoteScale));
  }
  const json = JSON.stringify(
    {
      model: config.AGENT_MODEL,
      maxTurns,
      seconds,
      spentUsd: spent,
      summaries,
      scores,
      episodes: results,
    },
    (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value),
    2,
  );
  if (values.out === undefined) {
    console.log(json);
  } else {
    await writeFile(values.out, `${json}\n`);
    console.error(`eval: results written to ${values.out}`);
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
