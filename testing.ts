import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer, connect, type Socket } from "node:net";
import { inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createClient } from "redis";
import { afterAll, beforeAll } from "vitest";
import { Exchange } from "./exchange.ts";
import { users } from "./schema.ts";
import { buildServer } from "./server.ts";
import { createAccessTokens } from "./tokens.ts";

export const TEST_SECRET = "t".repeat(32);

// Neither the ledger nor orders cascade, so test users' trading rows go first: trades, then
// orders, then the ledger. Whole ledger transactions are removed, system-account side
// included, which leaves every remaining transaction balanced.
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

// Test files share one Redis. A server that streams market data gets its own channel prefix,
// so it never hears another file's trades.
export function uniqueMarketDataPrefix(): string {
  return `test:${randomUUID()}:`;
}

// Each test file calls this once at the top level. Vitest gives every file its own module
// graph, so each file gets its own pool and app, and the hooks attach to that file.
export function useTestServer() {
  if (existsSync(".env")) {
    process.loadEnvFile(".env");
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined) {
    throw new Error("DATABASE_URL is not set: these tests talk to a real postgres");
  }
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
    await app.close();
    await Promise.all([
      pool.end(),
      redis.isOpen ? redis.close() : undefined,
      subscriber.isOpen ? subscriber.close() : undefined,
    ]);
  });

  return { pool, redis, subscriber, db, tokens, exchange, app, uniqueEmail };
}

// A TCP proxy in front of the compose Redis. A test connects its own client through it and
// can then make Redis slow (pause: replies are held back) or drop it after startup (cut: every
// connection is closed and new ones are refused), while other test files keep using Redis.
export async function redisProxy() {
  const redisUrl = process.env.REDIS_URL;
  if (redisUrl === undefined) {
    throw new Error("REDIS_URL is not set: these tests talk to a real redis");
  }
  const target = new URL(redisUrl);
  const sockets = new Set<Socket>();
  let paused = false;

  const server = createServer((client) => {
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
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("proxy has no port");
  }

  return {
    url: `redis://127.0.0.1:${address.port}`,
    pause() {
      paused = true;
    },
    cut() {
      server.close();
      for (const socket of sockets) {
        socket.destroy();
      }
    },
  };
}
