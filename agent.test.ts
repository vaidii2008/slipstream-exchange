// The agent loop against a scripted model: each test lists the replies the "model" gives, and
// the loop runs them through a real MCP server on a test exchange. No request reaches the
// Anthropic API, so these cost nothing and give the same answer every run.

import type Anthropic from "@anthropic-ai/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type CreateMessage,
  MAX_PROMPT_TOKENS,
  type ModelReply,
  type RequestUsage,
  requestCost,
  runAgent,
  taskPrompt,
} from "./agent.ts";
import { buildMcpServer, signInAgent } from "./mcp.ts";
import { useTestServer } from "./testing.ts";

const { app, uniqueEmail, testMarket } = useTestServer();
const PASSWORD = "agent-test-password";
const MODEL = "claude-haiku-5-5";
let baseUrl: string;
let symbol: string;

beforeAll(async () => {
  symbol = (await testMarket("BTC-USD")).symbol;
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (address === null || typeof address === "string") {
    throw new Error("server has no port");
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
});

const clients: Client[] = [];
afterAll(async () => {
  await Promise.all(clients.map((client) => client.close()));
});

// A funded agent's MCP server, connected in process.
async function mcpClient(): Promise<Client> {
  const session = await signInAgent(baseUrl, uniqueEmail("agent-test"), PASSWORD, symbol);
  await session.api.deposit("USD", 10_000_00000000n, 8);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await buildMcpServer(session).connect(serverSide);
  const client = new Client({ name: "agent-test", version: "0" });
  await client.connect(clientSide);
  clients.push(client);
  return client;
}

const usage = (input: number, output: number, write = 0, read = 0): RequestUsage => ({
  input_tokens: input,
  output_tokens: output,
  cache_creation_input_tokens: write,
  cache_read_input_tokens: read,
});

const text = (value: string): Anthropic.TextBlock => ({
  type: "text",
  text: value,
  citations: null,
});

let nextId = 0;
const use = (name: string, input: Record<string, unknown> = {}): Anthropic.ToolUseBlock => ({
  type: "tool_use",
  id: `toolu_${(nextId += 1)}`,
  name,
  input,
  caller: { type: "direct" },
});

const callsTools = (...blocks: Anthropic.ContentBlock[]): ModelReply => ({
  content: blocks,
  stop_reason: "tool_use",
  usage: usage(1000, 100),
});
const ends = (words: string): ModelReply => ({
  content: [text(words)],
  stop_reason: "end_turn",
  usage: usage(1000, 100),
});

// A model that gives the scripted replies in order, keeping a copy of every request.
function scripted(replies: ModelReply[]) {
  const requests: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const create: CreateMessage = (params) => {
    requests.push(JSON.parse(JSON.stringify(params)) as Anthropic.MessageCreateParamsNonStreaming);
    const reply = replies[requests.length - 1];
    if (reply === undefined) {
      throw new Error(`the script has no reply ${requests.length}`);
    }
    return Promise.resolve(reply);
  };
  return { create, requests };
}

const options = (create: CreateMessage, mcp: Client) => ({
  create,
  mcp,
  model: MODEL,
  task: taskPrompt(5),
  maxTurns: 5,
  budgetUsd: 1,
  deadline: Date.now() + 60_000,
});

describe("requestCost", () => {
  it("prices input, output, cache writes and cache reads at Haiku 5.5's rates", () => {
    // $0.10 per million input and $0.50 per million output; writes at 1.25x input, reads at
    // 0.1x. Every prompt here is at most 100K tokens, the cheaper rate card.
    expect(requestCost(MODEL, usage(100_000, 0))).toBeCloseTo(0.01);
    expect(requestCost(MODEL, usage(0, 1_000_000))).toBeCloseTo(0.5);
    expect(requestCost(MODEL, usage(0, 0, 80_000))).toBeCloseTo(0.01);
    expect(requestCost(MODEL, usage(0, 0, 0, 100_000))).toBeCloseTo(0.001);
  });

  it("charges five times as much for a prompt over 100K tokens, cached or not", () => {
    expect(requestCost(MODEL, usage(50_000, 1000, 0, 50_000))).toBeCloseTo(0.0055);
    expect(requestCost(MODEL, usage(50_001, 1000, 0, 50_000))).toBeCloseTo(0.0275025);
  });

  it("refuses a model it has no rates for", () => {
    expect(() => requestCost("claude-opus-5-5", usage(1, 1))).toThrow("no token rates");
  });
});

describe("runAgent", () => {
  it("runs the tools the model calls and gives every result back in one message", async () => {
    const mcp = await mcpClient();
    const market = use("get_market");
    const balances = use("get_balances");
    const model = scripted([callsTools(text("Looking first."), market, balances), ends("Done.")]);

    const run = await runAgent(options(model.create, mcp));

    expect(run).toMatchObject({ stopReason: "finished", turns: 2, finalText: "Done." });
    expect(run.toolCalls.map((call) => [call.name, call.isError])).toEqual([
      ["get_market", false],
      ["get_balances", false],
    ]);
    const second = model.requests[1];
    expect(second?.messages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
    const results = second?.messages[2]?.content as Anthropic.ToolResultBlockParam[];
    expect(results.map((result) => result.tool_use_id)).toEqual([market.id, balances.id]);
    expect(results[0]?.content).toContain(`"symbol":"${symbol}"`);
    expect(results[1]?.content).toContain('"available":"10000.00000000"');
  });

  it("gives the model the MCP server's tools and instructions, with the prefix cached", async () => {
    const mcp = await mcpClient();
    const model = scripted([ends("Nothing to do.")]);

    await runAgent(options(model.create, mcp));

    const [request] = model.requests;
    expect(request?.model).toBe(MODEL);
    // The loop sends only custom tools, each with a name.
    const tools = (request?.tools ?? []) as Anthropic.Tool[];
    expect(tools.map((tool) => tool.name)).toContain("place_order");
    const place = tools.find((tool) => tool.name === "place_order");
    expect(place?.input_schema.required).toContain("clientOrderId");
    const [system] = request?.system as Anthropic.TextBlockParam[];
    expect(system?.text).toContain(`You trade ${symbol}`);
    expect(system?.text).toContain("at most 5 turns");
    expect(system?.cache_control).toEqual({ type: "ephemeral" });
    expect(request?.cache_control).toEqual({ type: "ephemeral" });
  });

  it("hands a failed or unknown tool call back to the model as an error and carries on", async () => {
    const mcp = await mcpClient();
    const model = scripted([
      callsTools(
        use("place_order", { side: "buy", type: "limit", quantity: "0.001", price: "50000" }),
        use("withdraw_everything"),
      ),
      ends("I see."),
    ]);

    const run = await runAgent(options(model.create, mcp));

    expect(run.stopReason).toBe("finished");
    expect(run.toolCalls.map((call) => call.isError)).toEqual([true, true]);
    expect(run.toolCalls[0]?.error).toContain("clientOrderId");
    expect(run.toolCalls[1]?.error).toContain("withdraw_everything");
    const results = model.requests[1]?.messages[2]?.content as Anthropic.ToolResultBlockParam[];
    expect(results.map((result) => result.is_error)).toEqual([true, true]);
  });

  it("sums the tokens and the cost of every request", async () => {
    const mcp = await mcpClient();
    const model = scripted([
      { ...callsTools(use("get_market")), usage: usage(3000, 200, 2500, 0) },
      { ...ends("Done."), usage: usage(400, 50, 300, 2500) },
    ]);

    const run = await runAgent(options(model.create, mcp));

    expect(run.tokens).toEqual({
      requests: 2,
      input: 3400,
      output: 250,
      cacheWrite: 2800,
      cacheRead: 2500,
    });
    expect(run.costUsd).toBeCloseTo(
      requestCost(MODEL, usage(3000, 200, 2500, 0)) + requestCost(MODEL, usage(400, 50, 300, 2500)),
    );
    expect(run.largestPromptTokens).toBe(5500);
  });

  it("stops at the turn limit", async () => {
    const mcp = await mcpClient();
    const model = scripted(Array.from({ length: 3 }, () => callsTools(use("get_market"))));

    const run = await runAgent({ ...options(model.create, mcp), maxTurns: 3 });

    expect(run).toMatchObject({ stopReason: "max_turns", turns: 3 });
    expect(model.requests).toHaveLength(3);
  });

  it("sends no request once the budget is spent", async () => {
    const mcp = await mcpClient();
    // 1,000 input and 2,000 output tokens is $0.0011, past a $0.001 budget.
    const model = scripted([{ ...callsTools(use("get_market")), usage: usage(1000, 2000) }]);

    const run = await runAgent({ ...options(model.create, mcp), budgetUsd: 0.001 });

    expect(run).toMatchObject({ stopReason: "budget", turns: 1 });
    expect(run.costUsd).toBeCloseTo(0.0011);
  });

  it("stops before a request could pass the prompt limit", async () => {
    const mcp = await mcpClient();
    const model = scripted([
      { ...callsTools(use("get_market")), usage: usage(1000, 500, 0, MAX_PROMPT_TOKENS - 1000) },
    ]);

    const run = await runAgent(options(model.create, mcp));

    expect(run).toMatchObject({ stopReason: "context", turns: 1 });
    // The tool still ran: the model asked for it before the limit was reached.
    expect(run.toolCalls).toHaveLength(1);
  });

  it("starts no request after the deadline", async () => {
    const mcp = await mcpClient();
    const model = scripted([]);

    const run = await runAgent({ ...options(model.create, mcp), deadline: Date.now() - 1 });

    expect(run).toMatchObject({ stopReason: "deadline", turns: 0 });
    expect(model.requests).toHaveLength(0);
  });

  it("stops on a refusal without running anything", async () => {
    const mcp = await mcpClient();
    const model = scripted([
      { content: [use("get_market")], stop_reason: "refusal", usage: usage(1000, 10) },
    ]);

    const run = await runAgent(options(model.create, mcp));

    expect(run).toMatchObject({ stopReason: "refusal", toolCalls: [] });
  });
});
