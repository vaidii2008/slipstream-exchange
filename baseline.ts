// The rule-based baseline the agent is measured against: the simplest market maker that could
// work. Every step it cancels its quotes, reads the top of the book and quotes one tick inside
// it on both sides, until the episode's deadline. It trades through the same MCP server as the
// agent, so it meets the same tools, the same risk limits and the same scoring; the only
// difference is that a fixed rule, not a model, picks the calls.

import { connectMcp, recordedCall, type ToolCall } from "./agent.ts";
import type { Policy } from "./evals.ts";
import { formatAmount, parseAmount } from "./money.ts";

type Level = { price: string; quantity: string };

function parsed<T>(text: string): T {
  return JSON.parse(text) as T;
}

// The bid and ask to quote, one tick inside the best on each side, or at the best when the
// spread is too narrow to step inside. Prices are decimal strings at the quote scale.
export function quotes(
  bestBid: string,
  bestAsk: string,
  tickSize: string,
): { bid: string; ask: string } {
  const scale = tickSize.split(".")[1]?.length ?? 0;
  const read = (decimal: string) => {
    const result = parseAmount(decimal, scale);
    if (!result.ok) {
      throw new Error(`the MCP server sent an unreadable price ${decimal}`);
    }
    return result.units;
  };
  const tick = read(tickSize);
  const bid = read(bestBid) + tick;
  const ask = read(bestAsk) - tick;
  if (bid >= ask) {
    return { bid: bestBid, ask: bestAsk };
  }
  return { bid: formatAmount(bid, scale), ask: formatAmount(ask, scale) };
}

export function baselinePolicy(options: { stepMs: number; quantity: string }): Policy {
  return {
    name: "baseline",
    async run(session) {
      const mcp = await connectMcp({
        AGENT_API_URL: session.apiUrl,
        AGENT_EMAIL: session.email,
        AGENT_PASSWORD: session.password,
        AGENT_MARKET: session.symbol,
      });
      const toolCalls: ToolCall[] = [];
      let step = 0;
      const call = async (name: string, input: Record<string, unknown> = {}) => {
        const { call: recorded, text } = await recordedCall(mcp, step, name, input);
        toolCalls.push(recorded);
        return { isError: recorded.isError, text };
      };
      try {
        const market = await call("get_market");
        if (market.isError) {
          throw new Error(`get_market failed: ${market.text}`);
        }
        const { tickSize } = parsed<{ tickSize: string }>(market.text);

        while (Date.now() < session.deadline) {
          step += 1;
          const open = await call("get_open_orders");
          if (!open.isError) {
            for (const order of parsed<{ orders: { id: string }[] }>(open.text).orders) {
              await call("cancel_order", { orderId: order.id });
            }
          }
          const book = await call("get_order_book", { depth: 1 });
          if (!book.isError) {
            const { bids, asks } = parsed<{ bids: Level[]; asks: Level[] }>(book.text);
            const [bestBid] = bids;
            const [bestAsk] = asks;
            if (bestBid !== undefined && bestAsk !== undefined) {
              const { bid, ask } = quotes(bestBid.price, bestAsk.price, tickSize);
              for (const [side, price] of [
                ["buy", bid],
                ["sell", ask],
              ] as const) {
                await call("place_order", {
                  side,
                  type: "limit",
                  price,
                  quantity: options.quantity,
                  clientOrderId: `baseline-${step}-${side}`,
                });
              }
            }
          }
          await new Promise((resolve) =>
            setTimeout(
              resolve,
              Math.max(0, Math.min(options.stepMs, session.deadline - Date.now())),
            ),
          );
        }
        return {
          stopReason: "deadline",
          turns: step,
          toolCalls,
          tokens: { requests: 0, input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
          costUsd: 0,
        };
      } finally {
        await mcp.close();
      }
    },
  };
}
