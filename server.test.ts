import { existsSync } from "node:fs";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "./server.ts";
import { createAccessTokens } from "./tokens.ts";

if (existsSync(".env")) {
  process.loadEnvFile(".env");
}

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) {
  throw new Error("DATABASE_URL is not set: these tests talk to a real postgres");
}

const pool = new Pool({ connectionString: databaseUrl });
const db = drizzle({ client: pool });
const tokens = createAccessTokens("t".repeat(32));
const app = buildServer({
  pool,
  redis: { ping: () => Promise.resolve("PONG") },
  db,
  tokens,
});

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
  await app.close();
  await pool.end();
});

describe("central error handling", () => {
  const leakyMessage = 'duplicate key value violates "users_email_unique": argon2id$secret';
  const failing = buildServer({
    pool,
    redis: { ping: () => Promise.resolve("PONG") },
    db,
    tokens,
  });
  failing.get("/explode", () => {
    throw new Error(leakyMessage);
  });

  afterAll(async () => {
    await failing.close();
  });

  it("hides an unexpected error behind a bare internal_error", async () => {
    const response = await failing.inject({ method: "GET", url: "/explode" });

    expect(response.statusCode).toBe(500);
    expect(response.json<unknown>()).toEqual({ error: "internal_error" });
    expect(response.body).not.toContain("argon2id");
  });

  it("answers an unknown route with not_found", async () => {
    const response = await app.inject({ method: "GET", url: "/no-such-route" });

    expect(response.statusCode).toBe(404);
    expect(response.json<unknown>()).toEqual({ error: "not_found" });
  });

  it("answers malformed json with invalid_request and the parser's reason", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/login",
      headers: { "content-type": "application/json" },
      payload: '{"email":',
    });

    expect(response.statusCode).toBe(400);
    const body = response.json<{ error: string; message: unknown }>();
    expect(body.error).toBe("invalid_request");
    expect(typeof body.message).toBe("string");
  });

  it("names an unsupported content type in the same shape", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/login",
      headers: { "content-type": "application/xml" },
      payload: "<login/>",
    });

    expect(response.statusCode).toBe(415);
    expect(response.json<unknown>()).toMatchObject({ error: "unsupported_media_type" });
  });
});
