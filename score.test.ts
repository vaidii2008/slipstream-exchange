import { describe, expect, it } from "vitest";
import type { ToolCall } from "./agent.ts";
import type { Episode } from "./evals.ts";
import { classify, median, scoreEpisode, summarize, summaryTable } from "./score.ts";

const failed = (error: string): ToolCall => ({
  turn: 1,
  name: "place_order",
  input: {},
  isError: true,
  error,
});

describe("classify", () => {
  it("leaves a call that worked unclassified", () => {
    expect(classify({ turn: 1, name: "get_market", input: {}, isError: false })).toBeUndefined();
  });

  it("counts every risk_ code as a risk refusal", () => {
    for (const code of ["risk_max_order_quantity", "risk_max_position", "risk_killed"]) {
      expect(classify(failed(JSON.stringify({ error: code, message: "refused" })))).toBe("risk");
    }
  });

  it("blames the model for schema errors, unknown tools, bad fields, reused ids and others' orders", () => {
    const texts = [
      "MCP error -32602: Input validation error: Invalid arguments for tool place_order: clientOrderId",
      "MCP error -32602: Tool withdraw_everything not found",
      JSON.stringify({ error: "invalid_request", issues: [{ field: "price" }] }),
      JSON.stringify({ error: "client_order_id_reused", message: "differs" }),
      'POST /orders answered 400: {"error":"invalid_request"}',
      "DELETE /orders/0b6f answered 404: {}",
    ];
    expect(texts.map((text) => classify(failed(text)))).toEqual(texts.map(() => "invalid"));
  });

  it("counts an order the market would not take as an exchange refusal", () => {
    for (const code of ["insufficient_funds", "no_liquidity", "rate_limited", "market_busy"]) {
      expect(classify(failed(JSON.stringify({ error: code })))).toBe("rejected");
    }
  });

  it("calls anything else a failure of the harness, not the model", () => {
    expect(classify(failed("fetch failed"))).toBe("failed");
    expect(classify(failed("GET /balances answered 500: {}"))).toBe("failed");
    expect(classify(failed(JSON.stringify({ error: "unknown" })))).toBe("failed");
  });
});

describe("median", () => {
  it("is the middle value, or the mean of the middle two rounded toward zero", () => {
    expect(median([5n, -1n, 3n])).toBe(3n);
    expect(median([4n, 1n, 2n, 7n])).toBe(3n);
    expect(median([-4n, -1n])).toBe(-2n);
  });
});

const tokens = { requests: 2, input: 10, output: 20, cacheWrite: 30, cacheRead: 40 };

function episode(policy: string, pnl: bigint, calls: ToolCall[] = []): Episode {
  return {
    seed: 1,
    policy,
    email: "x@evals.slipstream.local",
    startEquity: 17_000_00000000n,
    endEquity: 17_000_00000000n + pnl,
    // 0.1 BTC while the mark rises by 100 USD: holding would have made 10 USD.
    startMark: 70_000_00000000n,
    endMark: 70_100_00000000n,
    startBase: 10000000n,
    baseScale: 8,
    fills: [
      { side: "buy", role: "taker", price: 70_000_00000000n, quantity: 1000000n },
      { side: "sell", role: "maker", price: 70_010_00000000n, quantity: 500000n },
    ],
    quoteScale: 8,
    run: { stopReason: "max_turns", turns: 4, toolCalls: calls, tokens, costUsd: 0.002 },
    durationMs: 60_000,
  };
}

describe("scoreEpisode", () => {
  it("scores P&L, fills, volume and each kind of failed call", () => {
    const calls: ToolCall[] = [
      { turn: 1, name: "get_market", input: {}, isError: false },
      failed(JSON.stringify({ error: "risk_max_position" })),
      failed("MCP error -32602: Tool nope not found"),
      failed(JSON.stringify({ error: "insufficient_funds" })),
    ];

    expect(scoreEpisode(episode("agent", -12_50000000n, calls))).toEqual({
      seed: 1,
      policy: "agent",
      pnl: -12_50000000n,
      holdPnl: 10_00000000n,
      fills: 2,
      makerFills: 1,
      volume: 1500000n,
      toolCalls: 4,
      riskRejections: 1,
      invalidToolCalls: 1,
      exchangeRejections: 1,
      failedToolCalls: 0,
      turns: 4,
      stopReason: "max_turns",
      tokens,
      costUsd: 0.002,
    });
  });
});

describe("summarize", () => {
  it("summarizes each policy apart, in the order they first appear", () => {
    const scores = [
      episode("agent", 10_00000000n),
      episode("baseline", -5_00000000n),
      episode("agent", -4_00000000n),
      episode("agent", 3_00000000n),
    ].map(scoreEpisode);

    const [agent, baseline] = summarize(scores);

    expect(agent).toMatchObject({
      policy: "agent",
      episodes: 3,
      pnl: {
        mean: 3_00000000n,
        median: 3_00000000n,
        min: -4_00000000n,
        max: 10_00000000n,
        positive: 2,
      },
      // 10, -4 and 3 against the 10 holding made: 0, -14 and -7. Matching it is not beating it.
      overHold: { mean: -7_00000000n, better: 0 },
      fills: 2,
      makerFills: 1,
      tokens: { requests: 6, input: 30, output: 60, cacheWrite: 90, cacheRead: 120 },
    });
    expect(agent?.costUsd).toBeCloseTo(0.006);
    expect(baseline).toMatchObject({ policy: "baseline", episodes: 1, pnl: { positive: 0 } });
  });

  it("prints a Markdown row per policy, P&L to the cent", () => {
    const table = summaryTable(summarize([episode("agent", -12_34567890n)].map(scoreEpisode)), 8);

    const [header, , row] = table.split("\n");
    expect(header).toContain("| Policy | Episodes | Mean P&L |");
    expect(row).toBe(
      "| agent | 1 | -12.34 | -12.34 | -12.34 to -12.34 | 0/1 | -22.34 | 0/1 | 2.0 | 1.0 | 0.0 | 0.0 | 0.0 | 80 | 20 | 0.0020 |",
    );
  });
});
