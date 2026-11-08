// Scores for eval episodes, and the summary across them. Pure functions of what an episode
// recorded, so the scoring can change, and be tested, without running anything.

import type { TokenTotals, ToolCall } from "./agent.ts";
import type { Episode } from "./evals.ts";
import { formatAmount } from "./money.ts";

// Why a tool call failed, from the error text the MCP server returned.
//   risk:     the risk limits refused it; nothing reached the exchange.
//   invalid:  the model's mistake: an unknown tool, arguments that break the tool's schema, a
//             field the API refused (off the tick, too many decimals), a reused client order
//             id, or an id that is not one of its orders.
//   rejected: a well-formed order the market would not take: not enough funds, nothing to
//             match a market order, the rate limit, a busy or halted market.
//   failed:   anything else, which is a harness or exchange problem, not the model's.
export type Failure = "risk" | "invalid" | "rejected" | "failed";

const INVALID_CODES = new Set(["invalid_request", "client_order_id_reused"]);
const REJECTED_CODES = new Set([
  "insufficient_funds",
  "no_liquidity",
  "rate_limited",
  "market_busy",
  "market_halted",
]);

function errorCode(text: string): string | undefined {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed === "object" && parsed !== null && "error" in parsed) {
      return String(parsed.error);
    }
  } catch {
    // Not JSON: a protocol error or an API error the client threw, matched below.
  }
  return undefined;
}

export function classify(call: ToolCall): Failure | undefined {
  if (!call.isError) {
    return undefined;
  }
  const text = call.error ?? "";
  const code = errorCode(text);
  if (code !== undefined) {
    if (code.startsWith("risk_")) {
      return "risk";
    }
    if (INVALID_CODES.has(code)) {
      return "invalid";
    }
    if (REJECTED_CODES.has(code)) {
      return "rejected";
    }
    return "failed";
  }
  // The SDK's InvalidParams error: an unknown tool or a schema violation.
  if (text.includes("MCP error -32602")) {
    return "invalid";
  }
  // The API client throws on 400 (a bad field) and 404 (not this account's order).
  if (/answered (400|404):/.test(text)) {
    return "invalid";
  }
  return "failed";
}

export type EpisodeScore = {
  seed: number;
  policy: string;
  // Quote minor units: end equity minus start equity.
  pnl: bigint;
  fills: number;
  makerFills: number;
  // Base minor units traded, both sides.
  volume: bigint;
  toolCalls: number;
  riskRejections: number;
  invalidToolCalls: number;
  exchangeRejections: number;
  failedToolCalls: number;
  turns: number;
  stopReason: string;
  tokens: TokenTotals;
  costUsd: number;
};

export function scoreEpisode(episode: Episode): EpisodeScore {
  const classes = episode.run.toolCalls.map(classify);
  const count = (failure: Failure) => classes.filter((c) => c === failure).length;
  return {
    seed: episode.seed,
    policy: episode.policy,
    pnl: episode.endEquity - episode.startEquity,
    fills: episode.fills.length,
    makerFills: episode.fills.filter((fill) => fill.role === "maker").length,
    volume: episode.fills.reduce((total, fill) => total + fill.quantity, 0n),
    toolCalls: episode.run.toolCalls.length,
    riskRejections: count("risk"),
    invalidToolCalls: count("invalid"),
    exchangeRejections: count("rejected"),
    failedToolCalls: count("failed"),
    turns: episode.run.turns,
    stopReason: episode.run.stopReason,
    tokens: episode.run.tokens,
    costUsd: episode.run.costUsd,
  };
}

// The middle value, or the mean of the two middle ones (rounded toward zero). Sorted copy.
export function median(values: bigint[]): bigint {
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const upper = sorted[Math.floor(sorted.length / 2)];
  if (upper === undefined) {
    throw new Error("no values");
  }
  if (sorted.length % 2 === 1) {
    return upper;
  }
  const lower = sorted[sorted.length / 2 - 1];
  return lower === undefined ? upper : (lower + upper) / 2n;
}

export type Summary = {
  policy: string;
  episodes: number;
  // P&L across episodes, quote minor units. mean rounds toward zero.
  pnl: { mean: bigint; median: bigint; min: bigint; max: bigint; positive: number };
  // Per episode, averaged.
  fills: number;
  makerFills: number;
  toolCalls: number;
  riskRejections: number;
  invalidToolCalls: number;
  exchangeRejections: number;
  // Across all episodes.
  tokens: TokenTotals;
  costUsd: number;
};

// One summary per policy, in the order the policies first appear.
export function summarize(scores: EpisodeScore[]): Summary[] {
  const policies = [...new Set(scores.map((score) => score.policy))];
  return policies.map((policy) => {
    const mine = scores.filter((score) => score.policy === policy);
    const n = mine.length;
    const pnls = mine.map((score) => score.pnl);
    const mean = (pick: (score: EpisodeScore) => number) =>
      mine.reduce((total, score) => total + pick(score), 0) / n;
    const tokens: TokenTotals = { requests: 0, input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
    for (const score of mine) {
      tokens.requests += score.tokens.requests;
      tokens.input += score.tokens.input;
      tokens.output += score.tokens.output;
      tokens.cacheWrite += score.tokens.cacheWrite;
      tokens.cacheRead += score.tokens.cacheRead;
    }
    return {
      policy,
      episodes: n,
      pnl: {
        mean: pnls.reduce((total, pnl) => total + pnl, 0n) / BigInt(n),
        median: median(pnls),
        min: pnls.reduce((low, pnl) => (pnl < low ? pnl : low)),
        max: pnls.reduce((high, pnl) => (pnl > high ? pnl : high)),
        positive: pnls.filter((pnl) => pnl > 0n).length,
      },
      fills: mean((score) => score.fills),
      makerFills: mean((score) => score.makerFills),
      toolCalls: mean((score) => score.toolCalls),
      riskRejections: mean((score) => score.riskRejections),
      invalidToolCalls: mean((score) => score.invalidToolCalls),
      exchangeRejections: mean((score) => score.exchangeRejections),
      tokens,
      costUsd: mine.reduce((total, score) => total + score.costUsd, 0),
    };
  });
}

// A Markdown table of the summaries, P&L in the quote asset to two decimals.
export function summaryTable(summaries: Summary[], quoteScale: number): string {
  const usd = (units: bigint) => {
    const [whole = "0", fraction = ""] = formatAmount(units, quoteScale).split(".");
    return `${whole}.${fraction.slice(0, 2).padEnd(2, "0")}`;
  };
  const one = (value: number) => value.toFixed(1);
  const rows = summaries.map((s) =>
    [
      s.policy,
      String(s.episodes),
      usd(s.pnl.mean),
      usd(s.pnl.median),
      `${usd(s.pnl.min)} to ${usd(s.pnl.max)}`,
      `${s.pnl.positive}/${s.episodes}`,
      one(s.fills),
      one(s.makerFills),
      one(s.riskRejections),
      one(s.invalidToolCalls),
      one(s.exchangeRejections),
      String(s.tokens.input + s.tokens.cacheWrite + s.tokens.cacheRead),
      String(s.tokens.output),
      s.costUsd.toFixed(4),
    ].join(" | "),
  );
  return [
    "| Policy | Episodes | Mean P&L | Median P&L | Range | Profitable | Fills | Maker fills | Risk refusals | Invalid calls | Exchange refusals | Prompt tokens | Output tokens | Cost (USD) |",
    "| --- | --: | --: | --: | --- | --: | --: | --: | --: | --: | --: | --: | --: | --: |",
    ...rows.map((row) => `| ${row} |`),
  ].join("\n");
}
