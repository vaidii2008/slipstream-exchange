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
import { ApiClient, type MarketInfo } from "./client.ts";
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

export function buildMcpServer(session: AgentSession): McpServer {
  return new McpServer(
    { name: "slipstream", version: "0.1.0" },
    { instructions: instructions(session.market) },
  );
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
