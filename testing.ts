import { randomUUID } from "node:crypto";
import { createServer, connect, type Socket } from "node:net";
import { inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createClient } from "redis";
import { afterAll, beforeAll } from "vitest";
import { Exchange } from "./exchange.ts";
import { loadMarket, type Market } from "./orders.ts";
import { users } from "./schema.ts";
import { buildServer } from "./server.ts";
import { testDatabaseUrl } from "./testdb.ts";
import { createAccessTokens } from "./tokens.ts";

export const TEST_SECRET = "t".repeat(32);

// Neither the ledger nor orders cascade, so test users' trading rows go first: trades, then
// orders, then the ledger. Whole ledger transactions are removed, system-account side
// included, which leaves every remaining transaction balanced and every cached balance equal
// to its account's entries.
async function deleteTradingHistory(pool: Pool, emails: string[]): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(
      `delete from trades t
       using orders o join users u on u.id = o.user_id
       where u.email = any($1) and o.id in (t.maker_order_id, t.taker_order_id)`,
      [emails],
    );
    await client.query(
      "delete from orders where user_id in (select id from users where email = any($1))",
      [emails],
    );
    await client.query(
      `create temporary table doomed_transactions on commit drop as
         select distinct e.transaction_id as id
         from ledger_entries e
         join ledger_accounts a on a.id = e.account_id
         join users u on u.id = a.user_id
         where u.email = any($1)`,
      [emails],
    );
    // The system accounts outlive the test, so their cached balances lose exactly what their
    // deleted entries had added. Locked in id order first, like any posting, so two files
    // cleaning up at once cannot deadlock on the system rows.
    await client.query(
      `create temporary table doomed_totals on commit drop as
         select e.account_id as id, sum(e.amount) as total
         from ledger_entries e
         join ledger_accounts a on a.id = e.account_id
         where e.transaction_id in (select id from doomed_transactions) and a.user_id is null
         group by e.account_id`,
    );
    await client.query(
      `select a.id from ledger_accounts a join doomed_totals d on d.id = a.id
       order by a.id for no key update of a`,
    );
    await client.query(
      `update ledger_accounts a set balance = a.balance - d.total
       from doomed_totals d where d.id = a.id`,
    );
    await client.query(
      "delete from ledger_entries where transaction_id in (select id from doomed_transactions)",
    );
    await client.query(
      "delete from ledger_transactions where id in (select id from doomed_transactions)",
    );
    await client.query(
      `delete from ledger_accounts
       where user_id in (select id from users where email = any($1))`,
      [emails],
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

// A market of the test's own, with the template's assets, tick, step and minimum: a symbol
// like BTC-USD-1a2b3c4d. A market's sequence numbers have one writer, its exchange, so every
// Exchange a test creates trades markets nobody else touches, even with test files running
// in parallel on one database. It also starts with an empty book, as each test expects.
export async function createTestMarket(
  pool: Pool,
  template: "BTC-USD" | "ETH-USD",
): Promise<Market> {
  const symbol = `${template}-${randomUUID().slice(0, 8)}`;
  const db = drizzle({ client: pool });
  await pool.query(
    `insert into markets (symbol, base_asset, quote_asset, tick_size, quantity_step, min_quantity)
     select $1, base_asset, quote_asset, tick_size, quantity_step, min_quantity
     from markets where symbol = $2`,
    [symbol, template],
  );
  const market = await loadMarket(db, symbol);
  if (market === undefined) {
    throw new Error(`${template} must be seeded to copy a test market from it`);
  }
  return market;
}

// Trades and orders on the test markets first, which also catches rows of users the file did
// not create through uniqueEmail, then their event logs, then the markets themselves.
async function deleteTestMarkets(pool: Pool, symbols: string[]): Promise<void> {
  await pool.query("delete from trades where market = any($1)", [symbols]);
  await pool.query("delete from engine_events where market = any($1)", [symbols]);
  await pool.query("delete from book_snapshots where market = any($1)", [symbols]);
  await pool.query("delete from orders where market = any($1)", [symbols]);
  await pool.query("delete from markets where symbol = any($1)", [symbols]);
}

// Test files share one Redis. A server that streams market data gets its own channel prefix,
// so it never hears another file's trades.
export function uniqueMarketDataPrefix(): string {
  return `test:${randomUUID()}:`;
}

// Each test file calls this once at the top level. Vitest gives every file its own module
// graph, so each file gets its own pool and app, and the hooks attach to that file.
export function useTestServer() {
  // slipstream_test, never the dev database. Vitest's global setup has created and migrated it.
  const databaseUrl = testDatabaseUrl();
  const redisUrl = process.env.REDIS_URL;
  if (redisUrl === undefined) {
    throw new Error("REDIS_URL is not set: these tests talk to a real redis");
  }

  const pool = new Pool({ connectionString: databaseUrl });
  const db = drizzle({ client: pool });
  const tokens = createAccessTokens(TEST_SECRET);
  // Connected in beforeAll; nothing sends it a command before the tests run.
  const redis = createClient({ url: redisUrl });
  const subscriber = redis.duplicate();
  const exchange = new Exchange(db);
  const app = buildServer(
    { pool, redis, subscriber, db, tokens, exchange },
    { marketDataPrefix: uniqueMarketDataPrefix() },
  );

  const createdEmails: string[] = [];
  const createdMarkets: string[] = [];

  async function testMarket(template: "BTC-USD" | "ETH-USD"): Promise<Market> {
    const market = await createTestMarket(pool, template);
    createdMarkets.push(market.symbol);
    return market;
  }

  function uniqueEmail(prefix: string): string {
    const email = `${prefix}-${randomUUID()}@slipstream.test`;
    createdEmails.push(email);
    return email;
  }

  beforeAll(async () => {
    try {
      await pool.query("select 1");
      await Promise.all([redis.connect(), subscriber.connect()]);
    } catch (error) {
      throw new Error("cannot reach postgres or redis: run `docker compose up -d --wait` first", {
        cause: error,
      });
    }
  });

  afterAll(async () => {
    if (createdEmails.length > 0) {
      await deleteTradingHistory(pool, createdEmails);
      await db.delete(users).where(inArray(users.email, createdEmails));
    }
    if (createdMarkets.length > 0) {
      await deleteTestMarkets(pool, createdMarkets);
    }
    await app.close();
    await Promise.all([
      pool.end(),
      redis.isOpen ? redis.close() : undefined,
      subscriber.isOpen ? subscriber.close() : undefined,
    ]);
  });

  return { pool, redis, subscriber, db, tokens, exchange, app, uniqueEmail, testMarket };
}

// A TCP proxy in front of the compose Redis. A test connects its own client through it and
// can then make Redis slow (pause: replies are held back), drop it after startup (cut: every
// connection is closed and new ones are refused) and bring it back on the same port
// (restore), while other test files keep using Redis.
export async function redisProxy() {
  const redisUrl = process.env.REDIS_URL;
  if (redisUrl === undefined) {
    throw new Error("REDIS_URL is not set: these tests talk to a real redis");
  }
  const target = new URL(redisUrl);
  const sockets = new Set<Socket>();
  let paused = false;

  const relay = (client: Socket) => {
    const upstream = connect(Number(target.port), target.hostname);
    for (const socket of [client, upstream]) {
      sockets.add(socket);
      socket.on("error", () => {
        client.destroy();
        upstream.destroy();
      });
      socket.on("close", () => {
        sockets.delete(socket);
        client.destroy();
        upstream.destroy();
      });
    }
    client.pipe(upstream);
    upstream.on("data", (chunk: Buffer) => {
      if (!paused) {
        client.write(chunk);
      }
    });
  };

  const listen = async (port: number) => {
    const server = createServer(relay);
    await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("proxy has no port");
    }
    return { server, port: address.port };
  };

  let { server, port } = await listen(0);

  return {
    url: `redis://127.0.0.1:${port}`,
    pause() {
      paused = true;
    },
    cut() {
      server.close();
      for (const socket of sockets) {
        socket.destroy();
      }
    },
    async restore() {
      ({ server, port } = await listen(port));
    },
  };
}
