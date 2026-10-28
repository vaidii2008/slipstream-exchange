import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll } from "vitest";
import { users } from "./schema.ts";
import { buildServer } from "./server.ts";
import { createAccessTokens } from "./tokens.ts";

export const TEST_SECRET = "t".repeat(32);

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
  const app = buildServer({
    pool,
    redis: { ping: () => Promise.resolve("PONG") },
    db,
    tokens,
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
      await db.delete(users).where(inArray(users.email, createdEmails));
    }
    await app.close();
    await pool.end();
  });

  return { pool, db, tokens, app, uniqueEmail };
}
