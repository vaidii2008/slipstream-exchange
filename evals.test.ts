// Episodes on the test exchange, with policies that need no model: a scripted one that trades
// through the API, and the agent policy driven by a scripted model through the real MCP
// server. The eval stack itself (Compose, a fresh database each episode) is not exercised here;
// these test what an episode does once it has an API to talk to.

import type Anthropic from "@anthropic-ai/sdk";
import { beforeAll, describe, expect, it } from "vitest";
import type { CreateMessage, ModelReply } from "./agent.ts";
import { ApiClient } from "./client.ts";
import { agentPolicy, type Policy, runEpisode } from "./evals.ts";
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

// An episode runs in real time: the fleet's warm-up, then the whole horizon.
const EPISODE_TIMEOUT_MS = 20_000;

const idle = { stopReason: "finished" as const, turns: 0, toolCalls: [], costUsd: 0 };
const noTokens = { requests: 0, input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };

describe("runEpisode", () => {
  it(
    "funds a new account once the fleet trades, runs the policy and marks it at the horizon",
    async () => {
      const symbol = (await testMarket("BTC-USD")).symbol;
      // An ask 100 USD above the fleet's 70,000, past the maker's outermost quote and any noise
      // limit. The maker requotes by cancelling every quote before placing new ones, so a market
      // buy that lands in that gap finds no ask and is cancelled, more often the slower the
      // machine. With this resting, the buy always fills.
      const backstop = new ApiClient(baseUrl, uniqueEmail("evals-test"), "evals-test-password");
      await backstop.signIn();
      const btcUsd = await backstop.market(symbol);
      await backstop.deposit("BTC", 100_000_000n, 8);
      await expect(
        backstop.place(btcUsd, {
          type: "limit",
          side: "sell",
          price: 70_100n * 100_000_000n,
          quantity: 100_000_000n,
        }),
      ).resolves.toMatchObject({ ok: true, status: "open" });
      let handed: { email: string; password: string; deadline: number } | undefined;
      // Buys 0.01 BTC at the market and stops.
      const buyer: Policy = {
        name: "buyer",
        async run(session) {
          handed = session;
          const api = new ApiClient(session.apiUrl, session.email, session.password);
          await api.signIn();
          const market = await api.market(session.symbol);
          const balances = await api.balances();
          expect(balances.get("BTC")).toEqual({ available: 10000000n, reserved: 0n });
          expect(balances.get("USD")).toEqual({ available: 10_000_00000000n, reserved: 0n });
          const bought = await api.place(market, {
            type: "market",
            side: "buy",
            quantity: 1000000n,
          });
          expect(bought).toMatchObject({ ok: true, status: "filled" });
          return { ...idle, tokens: noTokens };
        },
      };

      const started = Date.now();
      const episode = await runEpisode({
        apiUrl: baseUrl,
        symbol,
        seed: 3,
        policy: buyer,
        horizonMs: 1500,
        warmupTrades: 2,
        funding: { base: "0.1", quote: "10000" },
      });

      expect(episode).toMatchObject({ seed: 3, policy: "buyer", email: handed?.email });
      // The funding valued at the mark the episode recorded, to the minor unit.
      expect(episode.startBase).toBe(10000000n);
      expect(episode.startEquity).toBe(10_000_00000000n + episode.startMark / 10n);
      // 0.1 BTC near the fleet's 70,000 reference plus 10,000 USD.
      expect(Number(episode.startEquity) / 1e8).toBeGreaterThan(15_000);
      expect(Number(episode.startEquity) / 1e8).toBeLessThan(19_000);
      // The buy, as the account's fills: taker on the buy side, 0.01 BTC in all.
      expect(episode.fills.every((fill) => fill.side === "buy" && fill.role === "taker")).toBe(
        true,
      );
      expect(episode.fills.reduce((total, fill) => total + fill.quantity, 0n)).toBe(1000000n);
      // Buying 0.01 BTC across the spread costs a little, not hundreds.
      expect(Math.abs(Number(episode.endEquity - episode.startEquity)) / 1e8).toBeLessThan(200);
      // The policy stopped at once, but the episode waited for the horizon.
      expect(handed?.deadline).toBeGreaterThanOrEqual(started + 1500);
      expect(Date.now()).toBeGreaterThanOrEqual(handed?.deadline ?? Infinity);
    },
    EPISODE_TIMEOUT_MS,
  );
});

describe("agentPolicy", () => {
  // Rests a bid far below the market, then ends its turn.
  function bidThenStop(): CreateMessage {
    const replies: ModelReply[] = [
      {
        stop_reason: "tool_use",
        usage: {
          input_tokens: 100,
          output_tokens: 10,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        content: [
          {
            type: "tool_use",
            id: "toolu_bid",
            name: "place_order",
            caller: { type: "direct" },
            input: {
              side: "buy",
              type: "limit",
              price: "1000",
              quantity: "0.01",
              clientOrderId: "eval-bid-1",
            },
          } satisfies Anthropic.ToolUseBlock,
        ],
      },
      {
        stop_reason: "end_turn",
        usage: {
          input_tokens: 100,
          output_tokens: 10,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        content: [{ type: "text", text: "Resting a bid.", citations: null }],
      },
    ];
    let next = 0;
    return () => {
      const reply = replies[next];
      next += 1;
      if (reply === undefined) {
        throw new Error("the script has run out");
      }
      return Promise.resolve(reply);
    };
  }

  it(
    "trades through the MCP server, which cancels what it left resting when the episode closes it",
    async () => {
      const symbol = (await testMarket("BTC-USD")).symbol;
      const policy = agentPolicy({
        create: bidThenStop(),
        model: "claude-haiku-5-5",
        maxTurns: 5,
        budgetUsd: 0.01,
      });

      const episode = await runEpisode({
        apiUrl: baseUrl,
        symbol,
        seed: 4,
        policy,
        // Room to start the MCP server's process while the rest of the suite runs alongside.
        horizonMs: 4000,
        warmupTrades: 2,
        funding: { base: "0.1", quote: "10000" },
      });

      expect(episode.run).toMatchObject({ stopReason: "finished", turns: 2 });
      expect(episode.run.toolCalls).toEqual([
        expect.objectContaining({ name: "place_order", isError: false }),
      ]);
      expect(episode.run.costUsd).toBeGreaterThan(0);
      // The bid was resting when the model stopped; closing the server cancelled it.
      const book = (await fetch(`${baseUrl}/markets/${symbol}/book?depth=50`).then((reply) =>
        reply.json(),
      )) as { bids: { price: string }[] };
      expect(book.bids.map((bid) => bid.price)).not.toContain("1000.00000000");
    },
    EPISODE_TIMEOUT_MS,
  );
});
