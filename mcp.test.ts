import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiError } from "./client.ts";
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
