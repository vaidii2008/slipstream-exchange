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
import { ApiClient, type BookLevel, type MarketInfo, type OrderRequest } from "./client.ts";
import { parseAgentConfig } from "./config.ts";
import { AMOUNT_MESSAGES, formatAmount, parseAmount } from "./money.ts";
import {
  cancelAll,
  equity,
  LossLimit,
  RiskGuard,
  type RiskLimits,
  type RiskRefusal,
} from "./risk.ts";

// Per base asset, so they hold on a test's copy of a market too. An order is at most a few
// thousand dollars, and the position a few times that: room to trade, not to move the book.
const SIZE_LIMITS: Record<string, { maxOrderQuantity: string; maxPosition: string }> = {
  BTC: { maxOrderQuantity: "0.05", maxPosition: "0.25" },
  ETH: { maxOrderQuantity: "1", maxPosition: "5" },
};

export function defaultLimits(market: MarketInfo): RiskLimits {
  const sizes = SIZE_LIMITS[market.baseAsset];
  if (sizes === undefined) {
    throw new Error(`no agent limits for ${market.baseAsset}`);
  }
  const amount = (decimal: string, scale: number) => {
    const parsed = parseAmount(decimal, scale);
    if (!parsed.ok) {
      throw new Error(`bad agent limit ${decimal}: ${parsed.reason}`);
    }
    return parsed.units;
  };
  return {
    maxOrderQuantity: amount(sizes.maxOrderQuantity, market.baseScale),
    maxOpenOrders: 10,
    maxPosition: amount(sizes.maxPosition, market.baseScale),
    maxLoss: amount("5000", market.quoteScale),
  };
}

// Once tripped it stays tripped for the life of the process: the guard refuses every new
// order and everything resting is cancelled. Only the operator, by restarting the server,
// starts trading again. The model has no tool that resets it.
export class KillSwitch {
  readonly #api: ApiClient;
  readonly #market: MarketInfo;
  readonly #guard: RiskGuard;
  readonly #loss: LossLimit;
  readonly #inFlight = new Set<Promise<unknown>>();
  #tripping: Promise<void> | undefined;
  reason: string | undefined;

  constructor(api: ApiClient, market: MarketInfo, guard: RiskGuard, loss: LossLimit) {
    this.#api = api;
    this.#market = market;
    this.#guard = guard;
    this.#loss = loss;
  }

  get tripped(): boolean {
    return this.reason !== undefined;
  }

  // Runs an order placement so that a trip waits for it. Otherwise an order that passed the
  // guard just before the trip could reach the book after the cancels and stay there.
  async track<T>(work: Promise<T>): Promise<T> {
    this.#inFlight.add(work);
    try {
      return await work;
    } finally {
      this.#inFlight.delete(work);
    }
  }

  // Trips the switch if equity has fallen past the loss limit.
  async check(): Promise<void> {
    if (this.tripped) {
      return;
    }
    const breach = await this.#loss.breach(this.#api, this.#market);
    if (breach !== undefined) {
      await this.trip(breach);
    }
  }

  // Safe to call more than once or concurrently: every caller waits for the same cancels.
  async trip(reason: string): Promise<void> {
    await this.#halt(reason, `kill switch tripped (${reason})`);
  }

  // The server is going away: the same halt as a trip, so nothing the agent placed is left
  // resting in the book holding its funds with no one watching the loss limit.
  async stop(why: string): Promise<void> {
    await this.#halt(`the server is stopping (${why})`, `stopping (${why})`);
  }

  async #halt(reason: string, log: string): Promise<void> {
    if (this.#tripping === undefined) {
      this.reason = reason;
      this.#guard.killed = true;
      this.#tripping = (async () => {
        await Promise.allSettled([...this.#inFlight]);
        const cancelled = await cancelAll(this.#api, this.#market);
        console.error(`slipstream mcp: ${log}; cancelled ${cancelled}`);
      })();
    }
    await this.#tripping;
  }

  // Checks on a timer as well as on every order, so a resting order that fills into a loss
  // trips the switch even while the model has stopped calling tools. Returns the stop.
  watch(intervalMs: number): () => void {
    const timer = setInterval(() => {
      this.check().catch((error: unknown) => {
        console.error(`slipstream mcp: loss check failed: ${String(error)}`);
      });
    }, intervalMs);
    // The host closing stdin ends the process; this timer must not keep it alive.
    timer.unref();
    return () => clearInterval(timer);
  }
}

export type AgentSession = {
  api: ApiClient;
  market: MarketInfo;
  limits: RiskLimits;
  // Every order the model places goes through it. Reads may use api directly.
  guard: RiskGuard;
  kill: KillSwitch;
};

// Registers the agent's account the first time and signs in to it every time after, as a bot
// does, then reads the market it trades. Position limits are measured from the base it holds
// now, so they count from the start of this session, as a bot's count from its start.
export async function signInAgent(
  baseUrl: string,
  email: string,
  password: string,
  symbol: string,
  limitsFor: (market: MarketInfo) => RiskLimits = defaultLimits,
): Promise<AgentSession> {
  const api = new ApiClient(baseUrl, email, password);
  await api.signIn();
  const market = await api.market(symbol);
  const limits = limitsFor(market);
  const held = (await api.balances()).get(market.baseAsset);
  const inventory = held === undefined ? 0n : held.available + held.reserved;
  const guard = new RiskGuard(api, market, limits, inventory);
  const loss = new LossLimit(limits.maxLoss, await equity(api, market));
  return { api, market, limits, guard, kill: new KillSwitch(api, market, guard, loss) };
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

// isError tells the model the call did nothing. The text says why, in the API's own words
// where the API is the one refusing.
function failure(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

// Read tools change nothing, so a host may call them without asking the user first.
const READ_ONLY = { readOnlyHint: true, openWorldHint: false } as const;

export function buildMcpServer(session: AgentSession): McpServer {
  const { api, market, limits, guard, kill } = session;
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

  const haltMessage = () =>
    `trading is halted for good: ${kill.reason ?? "kill switch tripped"}; every open order was cancelled`;
  const halted = () => failure(JSON.stringify({ error: "risk_killed", message: haltMessage() }));

  const refusals: Record<RiskRefusal, string> = {
    max_order_quantity: `one order may ask for at most ${quantity(limits.maxOrderQuantity)} ${market.baseAsset}`,
    max_open_orders: `at most ${limits.maxOpenOrders} orders may rest at once; cancel one first`,
    max_position:
      `the ${market.baseAsset} position, counting every resting order as filled, may move at most ` +
      `${quantity(limits.maxPosition)} from where this session started`,
    killed: "trading is halted",
  };

  // Parsed here, not only by the API, because the risk checks need the amounts as numbers
  // before anything is sent. A bad one is worded exactly as the API would word it.
  const amount = (field: "price" | "quantity", value: string, scale: number) => {
    const parsed = parseAmount(value, scale);
    return parsed.ok
      ? parsed
      : {
          ok: false as const,
          error: JSON.stringify(fieldError(field, AMOUNT_MESSAGES[parsed.reason])),
        };
  };

  server.registerTool(
    "place_order",
    {
      title: "Place order",
      description:
        "Send a buy or sell order. A limit order needs a price and rests in the book until it fills or " +
        "is cancelled; a market order has no price and fills at once against the best resting orders. " +
        "Orders that would break a risk limit are refused before they reach the exchange. Limits: " +
        `${refusals.max_order_quantity}; ${refusals.max_open_orders}; ${refusals.max_position}. ` +
        `If equity falls more than ${price(limits.maxLoss)} ${market.quoteAsset} below where this ` +
        "session started, trading halts for good and every open order is cancelled.",
      inputSchema: {
        side: z.enum(["buy", "sell"]),
        type: z.enum(["limit", "market"]),
        quantity: z.string().max(64).describe(`In ${market.baseAsset}, as a decimal string.`),
        price: z
          .string()
          .max(64)
          .optional()
          .describe(
            `In ${market.quoteAsset}, as a decimal string. Required for limit, absent for market.`,
          ),
        // Required, not optional: a host may time out a call the exchange still carried out,
        // and a model that retries without the same id would place the order twice.
        clientOrderId: z
          .string()
          .min(1)
          .max(64)
          .describe(
            "Your own id for this order: 1 to 64 letters, digits or . _ : -. Use a new one for every " +
              "new order. If a call fails without saying why (a timeout, a dropped connection), retry " +
              "with the same id and the same fields: the exchange places it at most once and answers " +
              "with the first order. If such a retry is refused by a risk limit, the first attempt may " +
              "still have been placed; check get_open_orders.",
          ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => {
      await kill.check();
      if (kill.tripped) {
        return halted();
      }
      if (input.type === "limit" && input.price === undefined) {
        return failure(JSON.stringify(fieldError("price", "is required for a limit order")));
      }
      if (input.type === "market" && input.price !== undefined) {
        return failure(JSON.stringify(fieldError("price", "must be absent for a market order")));
      }
      const parsedQuantity = amount("quantity", input.quantity, market.baseScale);
      if (!parsedQuantity.ok) {
        return failure(parsedQuantity.error);
      }
      const { clientOrderId } = input;
      let order: OrderRequest;
      if (input.price === undefined) {
        order = { type: "market", side: input.side, quantity: parsedQuantity.units, clientOrderId };
      } else {
        const parsedPrice = amount("price", input.price, market.quoteScale);
        if (!parsedPrice.ok) {
          return failure(parsedPrice.error);
        }
        order = {
          type: "limit",
          side: input.side,
          price: parsedPrice.units,
          quantity: parsedQuantity.units,
          clientOrderId,
        };
      }

      // An order off the grid comes back from the API as a 400, which the client throws as an
      // ApiError carrying the API's body; the SDK turns that into an error result.
      const result = await kill.track(guard.place(market, order));
      if (result.ok) {
        const placed = {
          id: result.id,
          status: result.status,
          filled: quantity(result.filled),
          // True when clientOrderId had already placed this order and nothing new was sent.
          repeated: result.repeated,
        };
        // A fill from this very order can be what pushes equity past the limit.
        await kill.check();
        return json(kill.tripped ? { ...placed, halted: haltMessage() } : placed);
      }
      if (result.error === "risk_killed") {
        return halted();
      }
      if (result.status === 0) {
        const reason = Object.entries(refusals).find(([code]) => result.error === `risk_${code}`);
        return failure(
          JSON.stringify({
            error: result.error,
            message: `refused by the risk limits: ${reason?.[1] ?? result.error}`,
          }),
        );
      }
      return failure(
        JSON.stringify({
          error: result.error,
          ...(result.message === undefined ? {} : { message: result.message }),
        }),
      );
    },
  );

  server.registerTool(
    "cancel_order",
    {
      title: "Cancel order",
      description:
        "Cancel one of this account's resting orders by the id get_open_orders or place_order gave. " +
        "cancelled is false if it had already filled or been cancelled. Works after a halt too.",
      inputSchema: { orderId: z.uuid() },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ orderId }) => json({ cancelled: await guard.cancel(orderId) }),
  );

  return server;
}

// The API's shape for a field it refused, so the model sees one error format whichever side
// caught the mistake.
function fieldError(field: string, message: string) {
  return { error: "invalid_request", issues: [{ field, message }] };
}

// How often the loss limit is checked between tool calls. Each check is two GET requests.
const LOSS_CHECK_MS = 5000;

// How long the cancels on stop may take. The MCP spec's stdio shutdown, which the SDK's client
// follows, closes stdin, waits 2 s, sends SIGTERM, waits 2 s more, then sends SIGKILL; 3 s
// finishes inside that, and an API that does not answer cannot hold the process open.
export const STOP_DEADLINE_MS = 3000;

// Stops on whichever comes first: the host closing stdin (its normal way to end a session),
// SIGTERM or SIGINT. Later ones are ignored, so the SIGTERM that follows a slow stdin close
// does not cut the cancels short.
function stopOnExit(kill: KillSwitch): void {
  let stopping = false;
  const stop = (why: string) => {
    if (stopping) {
      return;
    }
    stopping = true;
    setTimeout(() => {
      console.error(`slipstream mcp: open orders not cancelled within ${STOP_DEADLINE_MS} ms`);
      process.exit(1);
    }, STOP_DEADLINE_MS);
    kill.stop(why).then(
      () => process.exit(0),
      (error: unknown) => {
        console.error(`slipstream mcp: cancelling open orders failed: ${String(error)}`);
        process.exit(1);
      },
    );
  };
  process.stdin.once("end", () => stop("stdin closed"));
  process.once("SIGTERM", () => stop("SIGTERM"));
  process.once("SIGINT", () => stop("SIGINT"));
}

async function serve(): Promise<void> {
  const config = parseAgentConfig(process.env);
  const session = await signInAgent(
    config.AGENT_API_URL,
    config.AGENT_EMAIL,
    config.AGENT_PASSWORD,
    config.AGENT_MARKET,
  );
  session.kill.watch(LOSS_CHECK_MS);
  stopOnExit(session.kill);
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
