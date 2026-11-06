import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
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

  const pool = new Pool({ connectionString: databaseUrl });
  const db = drizzle({ client: pool });
  const tokens = createAccessTokens(TEST_SECRET);
  const exchange = new Exchange(db);
  const app = buildServer({
    pool,
    redis: { ping: () => Promise.resolve("PONG") },
    db,
    tokens,
    exchange,
  });

  const createdEmails: string[] = [];

  function uniqueEmail(prefix: string): string {
    const email = `${prefix}-${randomUUID()}@slipstream.test`;
    createdEmails.push(email);
    return email;
  }

  beforeAll(async () => {
    try {
      await pool.query("select 1");
    } catch (error) {
      throw new Error("cannot reach postgres: run `docker compose up -d --wait` first", {
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
    await pool.end();
  });

  return { pool, db, tokens, exchange, app, uniqueEmail };
}
