// An MCP server that lets a language model trade on Slipstream. The host (Claude Desktop,
// Claude Code, an agent loop) starts it as a child process and speaks JSON-RPC to it over
// stdin and stdout. It is one more client of the public API, signed in as one agent account:
// every tool call becomes an HTTP request the terminal could have made, so the model gets no
// way into the engine, the ledger or another user's orders that a person does not have.
//
// stdout carries the protocol, so anything else this process prints goes to stderr. One
// stray console.log would be a malformed message to the host.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { ApiClient, type BookLevel, type MarketInfo } from "./client.ts";
import { parseAgentConfig } from "./config.ts";
import { formatAmount } from "./money.ts";

export type AgentSession = {
  api: ApiClient;
  market: MarketInfo;
};

// Registers the agent's account the first time and signs in to it every time after, as a bot
// does, then reads the market it trades.
export async function signInAgent(
  baseUrl: string,
  email: string,
  password: string,
  symbol: string,
): Promise<AgentSession> {
  const api = new ApiClient(baseUrl, email, password);
  await api.signIn();
  const market = await api.market(symbol);
  return { api, market };
}

// Sent to the host once, at initialize. Hosts put it in the model's context, so it is the
// place for what every tool call depends on: which market, and how amounts are written.
function instructions(market: MarketInfo): string {
  const quote = (units: bigint) => formatAmount(units, market.quoteScale);
  const base = (units: bigint) => formatAmount(units, market.baseScale);
  return [
    `You trade ${market.symbol} on Slipstream, a simulated exchange, as one account.`,
    `Prices are in ${market.quoteAsset}, quantities in ${market.baseAsset}, both as decimal strings.`,
    `A price must be a multiple of the tick size ${quote(market.tickSize)}.`,
    `A quantity must be a multiple of ${base(market.quantityStep)} and at least ${base(market.minQuantity)}.`,
  ].join("\n");
}

// Every result is one JSON text block, amounts as decimal strings at the asset's scale: what
// the API itself sends, and what the model writes back in an order.
function json(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

// Read tools change nothing, so a host may call them without asking the user first.
const READ_ONLY = { readOnlyHint: true, openWorldHint: false } as const;

export function buildMcpServer(session: AgentSession): McpServer {
  const { api, market } = session;
  const price = (units: bigint) => formatAmount(units, market.quoteScale);
  const quantity = (units: bigint) => formatAmount(units, market.baseScale);
  const level = (entry: BookLevel) => ({
    price: price(entry.price),
    quantity: quantity(entry.quantity),
  });

  const server = new McpServer(
    { name: "slipstream", version: "0.1.0" },
    { instructions: instructions(market) },
  );

  server.registerTool(
    "get_market",
    {
      title: "Market rules",
      description:
        "The market this account trades: its assets, the tick size every price must be a multiple of, " +
        "and the step and minimum every quantity must respect.",
      annotations: READ_ONLY,
    },
    () =>
      json({
        symbol: market.symbol,
        baseAsset: market.baseAsset,
        quoteAsset: market.quoteAsset,
        tickSize: price(market.tickSize),
        quantityStep: quantity(market.quantityStep),
        minQuantity: quantity(market.minQuantity),
      }),
  );

  // The caps keep one result to a few kilobytes, so a model polling the book does not spend
  // its context on levels it will never trade at.
  server.registerTool(
    "get_order_book",
    {
      title: "Order book",
      description:
        "The best price levels on each side of the book, best first: bids from the highest price down, " +
        "asks from the lowest up. Each level is a price and the total quantity resting there.",
      inputSchema: {
        depth: z.number().int().min(1).max(20).default(10).describe("Levels per side, 1 to 20."),
      },
      annotations: READ_ONLY,
    },
    async ({ depth }) => {
      const book = await api.book(market, depth);
      return json({ bids: book.bids.map(level), asks: book.asks.map(level) });
    },
  );

  server.registerTool(
    "get_recent_trades",
    {
      title: "Recent trades",
      description:
        "The market's latest trades, newest first. takerSide is the side of the order that crossed the " +
        "spread: buy means a buyer lifted an ask.",
      inputSchema: {
        limit: z.number().int().min(1).max(50).default(20).describe("Trades to return, 1 to 50."),
      },
      annotations: READ_ONLY,
    },
    async ({ limit }) => {
      const trades = await api.recentTrades(market, limit);
      return json({
        trades: trades.map((trade) => ({
          price: price(trade.price),
          quantity: quantity(trade.quantity),
          takerSide: trade.takerSide,
          time: trade.createdAt,
        })),
      });
    },
  );

  // Only the market's two assets, the only ones the agent can trade, and both even when the
  // account holds none, so the model never has to infer a zero from a missing row.
  server.registerTool(
    "get_balances",
    {
      title: "Balances",
      description:
        "This account's balance in the market's base and quote assets. available can be spent on a new " +
        "order; reserved is held by orders still resting in the book.",
      annotations: READ_ONLY,
    },
    async () => {
      const balances = await api.balances();
      const row = (asset: string, format: (units: bigint) => string) => {
        const held = balances.get(asset) ?? { available: 0n, reserved: 0n };
        return { asset, available: format(held.available), reserved: format(held.reserved) };
      };
      return json({
        balances: [row(market.baseAsset, quantity), row(market.quoteAsset, price)],
      });
    },
  );

  server.registerTool(
    "get_open_orders",
    {
      title: "Open orders",
      description:
        "This account's orders still resting in the book, with their ids for cancel_order. remaining is " +
        "the quantity not yet filled.",
      annotations: READ_ONLY,
    },
    async () => {
      const open = await api.openOrders(market);
      return json({
        orders: open.map((order) => ({
          id: order.id,
          side: order.side,
          price: order.price === null ? null : price(order.price),
          quantity: quantity(order.quantity),
          filled: quantity(order.filled),
          remaining: quantity(order.quantity - order.filled),
        })),
      });
    },
  );

  return server;
}

async function serve(): Promise<void> {
  const config = parseAgentConfig(process.env);
  const session = await signInAgent(
    config.AGENT_API_URL,
    config.AGENT_EMAIL,
    config.AGENT_PASSWORD,
    config.AGENT_MARKET,
  );
  await buildMcpServer(session).connect(new StdioServerTransport());
  console.error(
    `slipstream mcp: signed in as ${config.AGENT_EMAIL}, trading ${config.AGENT_MARKET}`,
  );
}

if (import.meta.main) {
  try {
    await serve();
  } catch (error) {
    // fetch reports an unreachable API as just "fetch failed", with the reason in its cause.
    const cause = error instanceof Error && error.cause instanceof Error ? error.cause : undefined;
    const message = error instanceof Error ? error.message : String(error);
    console.error(cause === undefined ? message : `${message}: ${cause.message}`);
    process.exit(1);
  }
}
