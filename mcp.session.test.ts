// One scripted session with the real server: `node mcp.ts` as a child process, JSON-RPC over
// its stdin and stdout, against a running exchange. The in-process tests in mcp.test.ts cover
// each tool; this checks the parts only a real process has: the stdio framing, configuration
// from the environment, nothing but protocol on stdout, and the default limits.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiClient, type MarketInfo } from "./client.ts";
import { useTestServer } from "./testing.ts";

const { app, uniqueEmail, testMarket } = useTestServer();
const PASSWORD = "mcp-session-password";
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

let client: Client | undefined;
afterAll(async () => {
  await client?.close();
});

async function funded(usd: bigint, btc: bigint): Promise<ApiClient> {
  const account = new ApiClient(baseUrl, uniqueEmail("mcp-session"), PASSWORD);
  await account.signIn();
  // The API refuses a zero deposit.
  for (const [asset, amount] of [
    ["USD", usd],
    ["BTC", btc],
  ] as const) {
    if (amount > 0n) {
      await account.deposit(asset, amount, 8);
    }
  }
  return account;
}

describe("a scripted MCP session over stdio", () => {
  it("reads, trades inside the limits, is refused past them and halts on a loss", async () => {
    // The agent's account exists and is funded before the server starts, as an operator
    // would set it up. 30,000 USD, no BTC.
    const email = uniqueEmail("mcp-session");
    const agent = new ApiClient(baseUrl, email, PASSWORD);
    await agent.signIn();
    await agent.deposit("USD", 30_000_00000000n, 8);
    const market: MarketInfo = await agent.market(symbol);

    // Five asks of 0.05 BTC at 70,000: exactly the 0.25 BTC the default limits allow.
    const seller = await funded(0n, 10_00000000n);
    for (let i = 0; i < 5; i += 1) {
      await seller.place(market, {
        type: "limit",
        side: "sell",
        price: 70_000_00000000n,
        quantity: 5000000n,
      });
    }

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["mcp.ts"],
      cwd: import.meta.dirname,
      // Only what the server needs, so the developer's own AGENT_* variables cannot leak in.
      env: {
        ...getDefaultEnvironment(),
        AGENT_API_URL: baseUrl,
        AGENT_EMAIL: email,
        AGENT_PASSWORD: PASSWORD,
        AGENT_MARKET: symbol,
      },
      stderr: "pipe",
    });
    let stderr = "";
    transport.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    client = new Client({ name: "mcp-session-test", version: "0" });
    await client.connect(transport);
    const session = client;

    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const result = await session.callTool({ name, arguments: args });
      const [block] = result.content as { type: string; text: string }[];
      const text = block?.text ?? "";
      let value: unknown;
      try {
        value = JSON.parse(text) as unknown;
      } catch {
        value = text;
      }
      return { isError: result.isError === true, value };
    };
    const buy = (quantity: string) =>
      call("place_order", { side: "buy", type: "market", quantity });

    // What the model sees first.
    const { tools } = await session.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "cancel_order",
      "get_balances",
      "get_market",
      "get_open_orders",
      "get_order_book",
      "get_recent_trades",
      "place_order",
    ]);
    expect(session.getInstructions()).toContain(`You trade ${symbol}`);
    expect((await call("get_market")).value).toMatchObject({ symbol, tickSize: "0.01000000" });
    expect((await call("get_balances")).value).toMatchObject({
      balances: [
        { asset: "BTC", available: "0.00000000" },
        { asset: "USD", available: "30000.00000000" },
      ],
    });
    expect((await call("get_order_book", { depth: 3 })).value).toEqual({
      bids: [],
      asks: [{ price: "70000.00000000", quantity: "0.25000000" }],
    });

    // Rest a bid, find it, cancel it.
    const bid = await call("place_order", {
      side: "buy",
      type: "limit",
      price: "60000",
      quantity: "0.01",
    });
    expect(bid).toMatchObject({ isError: false, value: { status: "open" } });
    const { id } = bid.value as { id: string };
    expect((await call("get_open_orders")).value).toMatchObject({ orders: [{ id }] });
    expect((await call("cancel_order", { orderId: id })).value).toEqual({ cancelled: true });

    // Refused by the risk limits, then by the API.
    expect(await buy("0.06")).toMatchObject({
      isError: true,
      value: { error: "risk_max_order_quantity" },
    });
    const offTick = await call("place_order", {
      side: "buy",
      type: "limit",
      price: "60000.001",
      quantity: "0.01",
    });
    expect(offTick).toMatchObject({ isError: true });
    expect(JSON.stringify(offTick.value)).toContain("must be a multiple of the market's tick size");

    // Five buys of 0.05 reach the position limit; one step more is refused.
    for (let i = 0; i < 5; i += 1) {
      expect(await buy("0.05")).toMatchObject({ isError: false, value: { status: "filled" } });
    }
    expect(await buy("0.0001")).toMatchObject({
      isError: true,
      value: { error: "risk_max_position" },
    });
    expect((await call("get_recent_trades", { limit: 1 })).value).toMatchObject({
      trades: [{ price: "70000.00000000", quantity: "0.05000000", takerSide: "buy" }],
    });
    // A sell lowers the position, so it may rest.
    const ask = await call("place_order", {
      side: "sell",
      type: "limit",
      price: "90000",
      quantity: "0.01",
    });
    expect(ask).toMatchObject({ isError: false, value: { status: "open" } });

    // Two other accounts trade at 40,000. The agent's 0.25 BTC is now worth 7,500 USD less,
    // past the default 5,000 USD loss limit.
    await seller.place(market, {
      type: "limit",
      side: "sell",
      price: 40_000_00000000n,
      quantity: 1000000n,
    });
    const buyer = await funded(10_000_00000000n, 0n);
    await buyer.place(market, { type: "market", side: "buy", quantity: 10000n });

    const halted = await call("place_order", {
      side: "sell",
      type: "limit",
      price: "90000",
      quantity: "0.01",
    });
    expect(halted).toMatchObject({ isError: true, value: { error: "risk_killed" } });
    expect(JSON.stringify(halted.value)).toContain("lost 750000000000 quote minor units");
    expect((await call("get_open_orders")).value).toEqual({ orders: [] });
    expect(await agent.openOrders(market)).toEqual([]);

    // stderr has the server's own lines; stdout had nothing but protocol, or the client
    // would have failed to parse a message above.
    expect(stderr).toContain(`signed in as ${email}`);
    expect(stderr).toContain("kill switch tripped");
  });
});
