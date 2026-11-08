// An agent loop: Claude decides, the MCP server's tools act, and the results go back to Claude
// until it stops, runs out of turns, time or budget. The model sees only what the MCP server
// exposes, so every guardrail in mcp.ts (the risk limits, the kill switch) still applies; this
// loop adds the ones that are about the model rather than the market: turns, tokens and money.
//
// It is a manual loop, not the SDK's tool runner, because the tools live in another process
// behind MCP and every request's usage has to be counted before the next one is sent.

import Anthropic from "@anthropic-ai/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { parseArgs } from "node:util";
import { parseAgentLoopConfig } from "./config.ts";

// US dollars per million tokens, for prompts of 100K tokens or fewer, from Anthropic's price
// list. A prompt over 100K costs five times as much (LONG_PROMPT_MULTIPLIER). Cache writes
// (5-minute) cost 1.25x input and cache reads 0.1x.
export const RATES: Record<string, { input: number; output: number }> = {
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
};
const LONG_PROMPT_TOKENS = 100_000;
const LONG_PROMPT_MULTIPLIER = 5;
const CACHE_WRITE = 1.25;
const CACHE_READ = 0.1;

// Stops before a request could cross LONG_PROMPT_TOKENS. The last request's prompt and output
// are both in the next prompt, and one round of tool results adds a few thousand tokens at
// most (the book and trades tools are capped), so 75K leaves room for that round.
export const MAX_PROMPT_TOKENS = 75_000;

export type RequestUsage = {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number | null;
  cache_read_input_tokens: number | null;
};

export type TokenTotals = {
  requests: number;
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
};

// Every token the model was sent: uncached, written to the cache and read from it.
export function promptTokens(usage: RequestUsage): number {
  return (
    usage.input_tokens +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0)
  );
}

// One request's cost in US dollars, from the usage the API reported. A float: it is an
// estimate that stops a run, not a balance anything is settled against.
export function requestCost(model: string, usage: RequestUsage): number {
  const rates = RATES[model];
  if (rates === undefined) {
    throw new Error(`no token rates for ${model}`);
  }
  const multiplier = promptTokens(usage) > LONG_PROMPT_TOKENS ? LONG_PROMPT_MULTIPLIER : 1;
  const input =
    usage.input_tokens +
    (usage.cache_creation_input_tokens ?? 0) * CACHE_WRITE +
    (usage.cache_read_input_tokens ?? 0) * CACHE_READ;
  return ((input * rates.input + usage.output_tokens * rates.output) * multiplier) / 1_000_000;
}

// The part of a Messages API response the loop reads, so a test can script the model.
export type ModelReply = Pick<Anthropic.Message, "content" | "stop_reason"> & {
  usage: RequestUsage;
};
export type CreateMessage = (
  params: Anthropic.MessageCreateParamsNonStreaming,
) => Promise<ModelReply>;

export type ToolCall = {
  turn: number;
  name: string;
  input: unknown;
  isError: boolean;
  // The result's text when isError, so a scorer can say why it failed.
  error?: string;
};

export type StopReason =
  | "finished" // the model ended its turn without calling a tool
  | "max_turns"
  | "deadline"
  | "budget"
  | "context" // the next request could pass MAX_PROMPT_TOKENS
  | "refusal"
  | "max_tokens";

export type AgentRun = {
  stopReason: StopReason;
  turns: number;
  tokens: TokenTotals;
  costUsd: number;
  largestPromptTokens: number;
  toolCalls: ToolCall[];
  // The model's last words, for the log.
  finalText: string;
};

export type AgentOptions = {
  create: CreateMessage;
  mcp: Client;
  model: string;
  task: string;
  maxTurns: number;
  budgetUsd: number;
  // Epoch milliseconds; no request starts after it.
  deadline: number;
  maxTokens?: number;
  log?: (line: string) => void;
};

// What the model is told about the job. The MCP server's own instructions (the market and how
// amounts are written) come first; this adds the goal and the limits of the episode.
export function taskPrompt(maxTurns: number): string {
  return [
    "Your goal is to end this session with more equity than you started with.",
    "Equity is your quote balance plus your base balance valued at the median of the market's last 20 trades.",
    `You have at most ${maxTurns} turns; each of your replies is one turn, and you may call several tools in one turn.`,
    "Other traders act while you think, so the book can change between turns.",
    "The session ends when you reply without calling a tool, or when the turns or the time run out.",
    "When it ends, every order still resting is cancelled, so an order you want filled needs the session to stay open: keep checking the book and your orders instead of replying early.",
    "Keep your reasoning short.",
  ].join("\n");
}

// Text of an MCP tool result: its text blocks joined. The server sends nothing else.
function resultText(content: unknown): string {
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((block: unknown) =>
      typeof block === "object" && block !== null && "text" in block ? String(block.text) : "",
    )
    .join("\n");
}

// Calls one tool and records the call as a scorer sees it. Never throws: a protocol error (an
// unknown tool, arguments that break the schema) is the caller's mistake to see, not a reason
// to end the run, so it comes back as an error result like any other.
export async function recordedCall(
  mcp: Client,
  turn: number,
  name: string,
  input: unknown,
): Promise<{ call: ToolCall; text: string }> {
  let text: string;
  let isError: boolean;
  try {
    const result = await mcp.callTool({
      name,
      arguments: (input ?? {}) as Record<string, unknown>,
    });
    text = resultText(result.content);
    isError = result.isError === true;
  } catch (error) {
    text = error instanceof Error ? error.message : String(error);
    isError = true;
  }
  return { call: { turn, name, input, isError, ...(isError ? { error: text } : {}) }, text };
}

export async function runAgent(options: AgentOptions): Promise<AgentRun> {
  const { mcp, model, maxTurns, budgetUsd, deadline } = options;
  const log = options.log ?? (() => {});

  // MCP's inputSchema is JSON Schema, which is what the Messages API takes.
  const listed = await mcp.listTools();
  const tools: Anthropic.Tool[] = listed.tools.map((tool) => ({
    name: tool.name,
    description: tool.description ?? "",
    input_schema: tool.inputSchema,
  }));
  // Tools, then system, are the cached prefix. Both are fixed for the run, so every request
  // after the first reads them from the cache.
  const system: Anthropic.TextBlockParam[] = [
    {
      type: "text",
      text: `${mcp.getInstructions() ?? ""}\n\n${options.task}`,
      cache_control: { type: "ephemeral" },
    },
  ];
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: "The session has started. Trade." },
  ];

  const tokens: TokenTotals = { requests: 0, input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
  const toolCalls: ToolCall[] = [];
  let costUsd = 0;
  let largestPromptTokens = 0;
  let finalText = "";
  let turns = 0;

  const finish = (stopReason: StopReason): AgentRun => {
    log(`agent: stopped (${stopReason}) after ${turns} turns, $${costUsd.toFixed(4)}`);
    return { stopReason, turns, tokens, costUsd, largestPromptTokens, toolCalls, finalText };
  };

  for (;;) {
    if (turns >= maxTurns) {
      return finish("max_turns");
    }
    if (Date.now() >= deadline) {
      return finish("deadline");
    }
    if (costUsd >= budgetUsd) {
      return finish("budget");
    }

    const reply = await options.create({
      model,
      max_tokens: options.maxTokens ?? 8000,
      system,
      tools,
      messages,
      // Moves the cache breakpoint to the end of the conversation each request, so the history
      // is read from the cache and only the newest turn is written.
      cache_control: { type: "ephemeral" },
    });
    turns += 1;
    tokens.requests += 1;
    tokens.input += reply.usage.input_tokens;
    tokens.output += reply.usage.output_tokens;
    tokens.cacheWrite += reply.usage.cache_creation_input_tokens ?? 0;
    tokens.cacheRead += reply.usage.cache_read_input_tokens ?? 0;
    costUsd += requestCost(model, reply.usage);
    const prompt = promptTokens(reply.usage);
    largestPromptTokens = Math.max(largestPromptTokens, prompt);

    const text = reply.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();
    if (text !== "") {
      finalText = text;
      log(`agent turn ${turns}: ${text}`);
    }
    // The whole reply goes back, thinking blocks included and unchanged, as the API requires.
    messages.push({ role: "assistant", content: reply.content });

    if (reply.stop_reason === "refusal" || reply.stop_reason === "max_tokens") {
      return finish(reply.stop_reason);
    }
    const uses = reply.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
    );
    if (uses.length === 0) {
      return finish("finished");
    }

    // In the order the model asked, one at a time: two orders sent at once would race each
    // other through the risk checks.
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const use of uses) {
      const { call, text } = await recordedCall(mcp, turns, use.name, use.input);
      log(`  ${use.name} ${JSON.stringify(use.input)} -> ${call.isError ? "error: " : ""}${text}`);
      toolCalls.push(call);
      results.push({
        type: "tool_result",
        tool_use_id: use.id,
        content: text,
        is_error: call.isError,
      });
    }
    // Every result in one user message: splitting them teaches the model to stop calling tools
    // in parallel.
    messages.push({ role: "user", content: results });

    if (prompt + reply.usage.output_tokens > MAX_PROMPT_TOKENS) {
      return finish("context");
    }
  }
}

// Starts `node mcp.ts` as a child process and connects to it, as a host would. Only the
// variables the server reads are passed, so nothing else in this process's environment (the
// Anthropic key among them) reaches it.
export async function connectMcp(env: {
  AGENT_API_URL: string;
  AGENT_EMAIL: string;
  AGENT_PASSWORD: string;
  AGENT_MARKET: string;
}): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["mcp.ts"],
    cwd: import.meta.dirname,
    env: { ...getDefaultEnvironment(), ...env },
    stderr: "inherit",
  });
  const client = new Client({ name: "slipstream-agent", version: "0.1.0" });
  await client.connect(transport);
  return client;
}

// `npm run agent -- --turns 10 --budget 0.05`: one run against the exchange in AGENT_API_URL.
async function main(): Promise<void> {
  const config = parseAgentLoopConfig(process.env);
  const { values } = parseArgs({
    options: {
      turns: { type: "string", default: "10" },
      budget: { type: "string", default: "0.05" },
      minutes: { type: "string", default: "5" },
    },
  });
  const maxTurns = Number(values.turns);
  const budgetUsd = Number(values.budget);
  const minutes = Number(values.minutes);
  if (![maxTurns, budgetUsd, minutes].every((n) => Number.isFinite(n) && n > 0)) {
    throw new Error("--turns, --budget and --minutes must be positive numbers");
  }

  if (RATES[config.AGENT_MODEL] === undefined) {
    throw new Error(`no token rates for ${config.AGENT_MODEL}, so its budget cannot be enforced`);
  }
  const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
  const mcp = await connectMcp({
    AGENT_API_URL: config.AGENT_API_URL,
    AGENT_EMAIL: config.AGENT_EMAIL,
    AGENT_PASSWORD: config.AGENT_PASSWORD,
    AGENT_MARKET: config.AGENT_MARKET,
  });
  try {
    const run = await runAgent({
      create: (params) => anthropic.messages.create(params),
      mcp,
      model: config.AGENT_MODEL,
      task: taskPrompt(maxTurns),
      maxTurns,
      budgetUsd,
      deadline: Date.now() + minutes * 60_000,
      log: (line) => console.error(line),
    });
    const { toolCalls, ...summary } = run;
    console.log(JSON.stringify({ ...summary, toolCalls: toolCalls.length }, null, 2));
  } finally {
    // Closing stdin is the MCP server's cue to cancel what the agent left resting.
    await mcp.close();
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
