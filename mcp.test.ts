import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiClient, ApiError } from "./client.ts";
import { type AgentSession, buildMcpServer, defaultLimits, signInAgent } from "./mcp.ts";
import type { RiskLimits } from "./risk.ts";
import { useTestServer } from "./testing.ts";

const { app, uniqueEmail, testMarket } = useTestServer();
const PASSWORD = "mcp-test-password";
let baseUrl: string;
let btc: string;
// The trading tests' own market, so orders the read tests leave resting cannot fill theirs.
let trading: string;

beforeAll(async () => {
  [btc, trading] = await Promise.all([
    testMarket("BTC-USD").then((market) => market.symbol),
    testMarket("BTC-USD").then((market) => market.symbol),
  ]);
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (address === null || typeof address === "string") {
    throw new Error("server has no port");
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
});

// An MCP client connected to a server for `session` in this process, over a linked pair of
// in-memory transports: the same JSON-RPC messages as stdio, without the child process.
const clients: Client[] = [];
afterAll(async () => {
  await Promise.all(clients.map((client) => client.close()));
});

async function connect(session: AgentSession): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await buildMcpServer(session).connect(serverSide);
  const client = new Client({ name: "mcp-test", version: "0" });
  await client.connect(clientSide);
  clients.push(client);
  return client;
}

// Calls a tool and returns its result, with the JSON text block parsed.
async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  const [block] = result.content as { type: string; text: string }[];
  if (block?.type !== "text") {
    throw new Error(`${name} returned no text`);
  }
  return { isError: result.isError === true, text: block.text, value: parseJson(block.text) };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // An error result is plain text, not JSON.
    return undefined;
  }
}

// Another account on the same market, to put orders in the book and trade against.
async function counterparty(): Promise<ApiClient> {
  const other = new ApiClient(baseUrl, uniqueEmail("mcp-other"), PASSWORD);
  await other.signIn();
  await other.deposit("USD", 1_000_000_00000000n, 8);
  await other.deposit("BTC", 10_00000000n, 8);
  return other;
}

describe("signInAgent", () => {
  it("registers the account the first time and signs in to the same one after", async () => {
    const email = uniqueEmail("mcp-test");
    const first = await signInAgent(baseUrl, email, PASSWORD, btc);
    await first.api.deposit("USD", 5_00000000n, 8);

    const again = await signInAgent(baseUrl, email, PASSWORD, btc);
    expect((await again.api.balances()).get("USD")).toEqual({
      available: 5_00000000n,
      reserved: 0n,
    });
    expect(again.market).toMatchObject({ symbol: btc, baseAsset: "BTC", quoteAsset: "USD" });
  });

  it("fails on the wrong password for an existing account", async () => {
    const email = uniqueEmail("mcp-test");
    await signInAgent(baseUrl, email, PASSWORD, btc);
    await expect(signInAgent(baseUrl, email, "not-the-password", btc)).rejects.toThrow(ApiError);
  });
});

describe("buildMcpServer", () => {
  it("introduces itself with the market's grid in its instructions", async () => {
    const client = await connect(
      await signInAgent(baseUrl, uniqueEmail("mcp-test"), PASSWORD, btc),
    );

    expect(client.getServerVersion()).toMatchObject({ name: "slipstream" });
    const instructions = client.getInstructions() ?? "";
    expect(instructions).toContain(`You trade ${btc}`);
    expect(instructions).toContain("tick size 0.01000000");
    expect(instructions).toContain("multiple of 0.00010000 and at least 0.00010000");
  });
});

describe("read tools", () => {
  it("lists the read tools, each marked read-only", async () => {
    const client = await connect(
      await signInAgent(baseUrl, uniqueEmail("mcp-test"), PASSWORD, btc),
    );

    const { tools } = await client.listTools();
    const read = [
      "get_market",
      "get_order_book",
      "get_recent_trades",
      "get_balances",
      "get_open_orders",
    ];
    expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(read));
    for (const tool of tools.filter((t) => read.includes(t.name))) {
      expect(tool.annotations?.readOnlyHint, tool.name).toBe(true);
      expect(tool.description, tool.name).toBeTruthy();
    }
  });

  it("gives the market's grid as decimal strings", async () => {
    const client = await connect(
      await signInAgent(baseUrl, uniqueEmail("mcp-test"), PASSWORD, btc),
    );

    expect((await call(client, "get_market")).value).toEqual({
      symbol: btc,
      baseAsset: "BTC",
      quoteAsset: "USD",
      tickSize: "0.01000000",
      quantityStep: "0.00010000",
      minQuantity: "0.00010000",
    });
  });

  it("shows the book best first, the latest trades and the agent's own orders and balances", async () => {
    const session = await signInAgent(baseUrl, uniqueEmail("mcp-test"), PASSWORD, btc);
    const client = await connect(session);
    const other = await counterparty();
    const ask = (price: bigint) =>
      other.place(session.market, { type: "limit", side: "sell", price, quantity: 1000000n });
    await ask(70_100_00000000n);
    await ask(70_000_00000000n);
    await ask(70_000_00000000n);

    // The agent buys 0.01 BTC from the best ask and rests a bid for 0.0005 BTC under it.
    await session.api.deposit("USD", 2_000_00000000n, 8);
    const bought = await session.api.place(session.market, {
      type: "market",
      side: "buy",
      quantity: 1000000n,
    });
    expect(bought).toMatchObject({ ok: true, status: "filled" });
    const bid = await session.api.place(session.market, {
      type: "limit",
      side: "buy",
      price: 69_000_00000000n,
      quantity: 50000n,
    });
    if (!bid.ok) {
      throw new Error(`bid refused: ${bid.error}`);
    }

    expect((await call(client, "get_order_book", { depth: 5 })).value).toEqual({
      bids: [{ price: "69000.00000000", quantity: "0.00050000" }],
      asks: [
        { price: "70000.00000000", quantity: "0.01000000" },
        { price: "70100.00000000", quantity: "0.01000000" },
      ],
    });
    expect((await call(client, "get_recent_trades", { limit: 1 })).value).toEqual({
      trades: [
        {
          price: "70000.00000000",
          quantity: "0.01000000",
          takerSide: "buy",
          time: expect.stringMatching(/^\d{4}-\d\d-\d\dT/) as unknown,
        },
      ],
    });
    // 2,000 USD less 700 spent and 34.50 held by the bid.
    expect((await call(client, "get_balances")).value).toEqual({
      balances: [
        { asset: "BTC", available: "0.01000000", reserved: "0.00000000" },
        { asset: "USD", available: "1265.50000000", reserved: "34.50000000" },
      ],
    });
    expect((await call(client, "get_open_orders")).value).toEqual({
      orders: [
        {
          id: bid.id,
          side: "buy",
          price: "69000.00000000",
          quantity: "0.00050000",
          filled: "0.00000000",
          remaining: "0.00050000",
        },
      ],
    });
  });

  it("shows zero balances for an account that holds nothing", async () => {
    const client = await connect(
      await signInAgent(baseUrl, uniqueEmail("mcp-test"), PASSWORD, btc),
    );

    expect((await call(client, "get_balances")).value).toEqual({
      balances: [
        { asset: "BTC", available: "0.00000000", reserved: "0.00000000" },
        { asset: "USD", available: "0.00000000", reserved: "0.00000000" },
      ],
    });
  });

  it("refuses a depth past the cap with an error the model can read", async () => {
    const client = await connect(
      await signInAgent(baseUrl, uniqueEmail("mcp-test"), PASSWORD, btc),
    );

    const result = await call(client, "get_order_book", { depth: 21 });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/expected number to be <=20 at depth/);
  });
});

describe("trading tools", () => {
  // Small enough to reach in a test: 0.01 BTC an order, 3 resting, 0.02 BTC of position.
  const tight = (): RiskLimits => ({
    maxOrderQuantity: 1000000n,
    maxOpenOrders: 3,
    maxPosition: 2000000n,
    maxLoss: 1_000_00000000n,
  });

  // A funded agent with tight limits, and its MCP client.
  async function trader() {
    const email = uniqueEmail("mcp-test");
    const funding = await signInAgent(baseUrl, email, PASSWORD, trading);
    await funding.api.deposit("USD", 10_000_00000000n, 8);
    await funding.api.deposit("BTC", 1_00000000n, 8);
    const session = await signInAgent(baseUrl, email, PASSWORD, trading, tight);
    return { session, client: await connect(session) };
  }

  const bid = (price: string, quantity = "0.001") => ({
    side: "buy",
    type: "limit",
    price,
    quantity,
  });

  it("marks place_order destructive and cancel_order idempotent", async () => {
    const { client } = await trader();
    const { tools } = await client.listTools();
    const place = tools.find((tool) => tool.name === "place_order");
    const cancel = tools.find((tool) => tool.name === "cancel_order");
    expect(place?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(cancel?.annotations).toMatchObject({ readOnlyHint: false, idempotentHint: true });
    // The limits are in the description, so the model can stay inside them.
    expect(place?.description).toContain("at most 0.01000000 BTC");
  });

  it("rests a limit order, then cancels it once", async () => {
    const { client } = await trader();

    const placed = await call(client, "place_order", bid("60000"));
    expect(placed).toMatchObject({
      isError: false,
      value: { status: "open", filled: "0.00000000" },
    });
    const { id } = placed.value as { id: string };
    expect((await call(client, "get_open_orders")).value).toMatchObject({ orders: [{ id }] });

    expect((await call(client, "cancel_order", { orderId: id })).value).toEqual({
      cancelled: true,
    });
    expect((await call(client, "cancel_order", { orderId: id })).value).toEqual({
      cancelled: false,
    });
    expect((await call(client, "get_open_orders")).value).toEqual({ orders: [] });
  });

  it("fills a market order against the book", async () => {
    const { session, client } = await trader();
    const other = await counterparty();
    await other.place(session.market, {
      type: "limit",
      side: "sell",
      price: 65_000_00000000n,
      quantity: 500000n,
    });

    const result = await call(client, "place_order", {
      side: "buy",
      type: "market",
      quantity: "0.005",
    });
    expect(result).toMatchObject({
      isError: false,
      value: { status: "filled", filled: "0.00500000" },
    });
  });

  it("refuses a price that is missing, unneeded or malformed, worded as the API words it", async () => {
    const { client } = await trader();

    const missing = await call(client, "place_order", {
      side: "buy",
      type: "limit",
      quantity: "0.001",
    });
    expect(missing).toMatchObject({ isError: true });
    expect(missing.value).toEqual({
      error: "invalid_request",
      issues: [{ field: "price", message: "is required for a limit order" }],
    });
    const unneeded = await call(client, "place_order", {
      side: "buy",
      type: "market",
      quantity: "0.001",
      price: "60000",
    });
    expect(unneeded.value).toMatchObject({ issues: [{ field: "price" }] });
    const decimals = await call(client, "place_order", bid("60000", "0.000000001"));
    expect(decimals.value).toEqual({
      error: "invalid_request",
      issues: [{ field: "quantity", message: "has more decimals than the asset allows" }],
    });
    expect((await call(client, "get_open_orders")).value).toEqual({ orders: [] });
  });

  it("passes the API's own refusals through: off the tick, and not enough funds", async () => {
    const { client } = await trader();

    const offTick = await call(client, "place_order", bid("60000.005"));
    expect(offTick.isError).toBe(true);
    expect(offTick.text).toContain("400");
    expect(offTick.text).toContain('"field":"price"');

    // 0.01 BTC at 2,000,000 USD is 20,000 USD; the agent holds 10,000.
    const tooDear = await call(client, "place_order", bid("2000000", "0.01"));
    expect(tooDear.isError).toBe(true);
    expect(tooDear.value).toMatchObject({ error: "insufficient_funds" });
  });

  it("refuses, without sending, an order past each risk limit", async () => {
    const { client } = await trader();

    const tooBig = await call(client, "place_order", bid("60000", "0.0101"));
    expect(tooBig).toMatchObject({ isError: true, value: { error: "risk_max_order_quantity" } });
    expect(tooBig.text).toContain("at most 0.01000000 BTC");

    // Two 0.01 bids reach the 0.02 position limit; a third would pass it.
    await call(client, "place_order", bid("60000", "0.01"));
    await call(client, "place_order", bid("60001", "0.01"));
    const tooLong = await call(client, "place_order", bid("60002", "0.0001"));
    expect(tooLong).toMatchObject({ isError: true, value: { error: "risk_max_position" } });

    // A sell takes the position back, so the third resting order is allowed and the fourth is not.
    await call(client, "place_order", {
      side: "sell",
      type: "limit",
      price: "90000",
      quantity: "0.001",
    });
    const tooMany = await call(client, "place_order", {
      side: "sell",
      type: "limit",
      price: "90001",
      quantity: "0.001",
    });
    expect(tooMany).toMatchObject({ isError: true, value: { error: "risk_max_open_orders" } });
    expect(tooMany.text).toContain("at most 3 orders may rest at once");
    expect(
      ((await call(client, "get_open_orders")).value as { orders: unknown[] }).orders,
    ).toHaveLength(3);
  });

  it("cannot cancel an order that is not this account's", async () => {
    const { session, client } = await trader();
    const other = await counterparty();
    const theirs = await other.place(session.market, {
      type: "limit",
      side: "buy",
      price: 50_000_00000000n,
      quantity: 10000n,
    });
    if (!theirs.ok) {
      throw new Error(`their bid was refused: ${theirs.error}`);
    }

    const result = await call(client, "cancel_order", { orderId: theirs.id });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("404");
    expect(await other.openOrders(session.market)).toHaveLength(1);
  });

  it("uses the default limits per base asset", () => {
    expect(defaultLimits({ baseAsset: "BTC", baseScale: 8, quoteScale: 8 } as never)).toEqual({
      maxOrderQuantity: 5000000n,
      maxOpenOrders: 10,
      maxPosition: 25000000n,
      maxLoss: 5_000_00000000n,
    });
  });
});
