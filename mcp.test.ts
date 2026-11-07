import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiClient, ApiError } from "./client.ts";
import { type AgentSession, buildMcpServer, signInAgent } from "./mcp.ts";
import { useTestServer } from "./testing.ts";

const { app, uniqueEmail, testMarket } = useTestServer();
const PASSWORD = "mcp-test-password";
let baseUrl: string;
let btc: string;

beforeAll(async () => {
  btc = (await testMarket("BTC-USD")).symbol;
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
