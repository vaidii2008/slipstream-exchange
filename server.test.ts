import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { refreshTokens, users } from "./schema.ts";
import { buildServer } from "./server.ts";
import {
  createAccessTokens,
  DEFAULT_ACCESS_TOKEN_TTL_SECONDS,
  hashRefreshToken,
} from "./tokens.ts";

if (existsSync(".env")) {
  process.loadEnvFile(".env");
}

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) {
  throw new Error("DATABASE_URL is not set: these tests talk to a real postgres");
}

const pool = new Pool({ connectionString: databaseUrl });
const db = drizzle({ client: pool });
const TEST_SECRET = "t".repeat(32);
const tokens = createAccessTokens(TEST_SECRET);
const app = buildServer({
  pool,
  redis: { ping: () => Promise.resolve("PONG") },
  db,
  tokens,
});

const createdEmails: string[] = [];

function uniqueEmail(): string {
  const email = `register-test-${randomUUID()}@slipstream.test`;
  createdEmails.push(email);
  return email;
}

function register(email: string, password: string) {
  return app.inject({
    method: "POST",
    url: "/register",
    payload: { email, password },
  });
}

function login(email: string, password: string) {
  return app.inject({
    method: "POST",
    url: "/login",
    payload: { email, password },
  });
}

function me(authorization?: string) {
  return app.inject({
    method: "GET",
    url: "/me",
    headers: authorization === undefined ? {} : { authorization },
  });
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

describe("POST /register", () => {
  it("creates a user and returns the row without any credential material", async () => {
    const email = uniqueEmail();
    const response = await register(email, "hunter2hunter2");

    expect(response.statusCode).toBe(201);
    const body = response.json<unknown>();
    expect(body).toMatchObject({ email });
    expect(JSON.stringify(body)).not.toContain("hunter2hunter2");
    expect(JSON.stringify(body)).not.toContain("argon2");
  });

  it("rejects a second registration of the same email", async () => {
    const email = uniqueEmail();

    const first = await register(email, "hunter2hunter2");
    const second = await register(email, "a-different-password");

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(409);
    expect(second.json<unknown>()).toEqual({ error: "email_already_registered" });
  });

  it("rejects a duplicate differing only in case and surrounding space", async () => {
    const email = uniqueEmail();

    const first = await register(email, "hunter2hunter2");
    const second = await register(`  ${email.toUpperCase()}  `, "hunter2hunter2");

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(409);
  });

  it("lets exactly one of six concurrent registrations win", async () => {
    const email = uniqueEmail();

    const responses = await Promise.all(
      Array.from({ length: 6 }, () => register(email, "hunter2hunter2")),
    );
    const statuses = responses.map((response) => response.statusCode).sort((a, b) => a - b);

    expect(statuses).toEqual([201, 409, 409, 409, 409, 409]);

    const rows = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
    expect(rows).toHaveLength(1);
  });
});

describe("POST /login", () => {
  it("returns a bearer token that verifies to the registered user", async () => {
    const email = uniqueEmail();
    const registered = await register(email, "hunter2hunter2");
    const { id } = registered.json<{ id: string }>();

    const response = await login(email, "hunter2hunter2");

    expect(response.statusCode).toBe(200);
    const body = response.json<{ accessToken: string; tokenType: string }>();
    expect(body.tokenType).toBe("Bearer");
    await expect(tokens.verify(body.accessToken)).resolves.toMatchObject({ ok: true, userId: id });
  });

  it("sets a strict httpOnly refresh cookie and stores only its hash", async () => {
    const email = uniqueEmail();
    const registered = await register(email, "hunter2hunter2");
    const { id } = registered.json<{ id: string }>();

    const response = await login(email, "hunter2hunter2");

    const cookie = response.cookies.find((candidate) => candidate.name === "slipstream_refresh");
    if (cookie === undefined) {
      throw new Error("login set no slipstream_refresh cookie");
    }
    expect(cookie).toMatchObject({
      httpOnly: true,
      secure: true,
      sameSite: "Strict",
      path: "/session",
      maxAge: 604800,
    });

    const rows = await db
      .select({ tokenHash: refreshTokens.tokenHash })
      .from(refreshTokens)
      .where(eq(refreshTokens.userId, id));
    expect(rows).toEqual([{ tokenHash: hashRefreshToken(cookie.value) }]);
  });

  it("accepts the email in a different case with surrounding space", async () => {
    const email = uniqueEmail();
    await register(email, "hunter2hunter2");

    const response = await login(`  ${email.toUpperCase()}  `, "hunter2hunter2");

    expect(response.statusCode).toBe(200);
  });

  it("rejects a wrong password with invalid_credentials", async () => {
    const email = uniqueEmail();
    await register(email, "hunter2hunter2");

    const response = await login(email, "hunter2hunter3");

    expect(response.statusCode).toBe(401);
    expect(response.json<unknown>()).toEqual({ error: "invalid_credentials" });
  });

  it("answers an unknown email exactly as it answers a wrong password", async () => {
    const email = uniqueEmail();
    await register(email, "hunter2hunter2");

    const wrongPassword = await login(email, "hunter2hunter3");
    const unknownEmail = await login(
      `login-unknown-${randomUUID()}@slipstream.test`,
      "hunter2hunter3",
    );

    expect(unknownEmail.statusCode).toBe(wrongPassword.statusCode);
    expect(unknownEmail.body).toBe(wrongPassword.body);
  });

  it("rejects an empty password with invalid_request", async () => {
    const response = await login(uniqueEmail(), "");

    expect(response.statusCode).toBe(400);
    expect(response.json<unknown>()).toMatchObject({ error: "invalid_request" });
  });
});

describe("GET /me", () => {
  async function signedInUser() {
    const email = uniqueEmail();
    const registered = await register(email, "hunter2hunter2");
    const { id } = registered.json<{ id: string }>();
    const loggedIn = await login(email, "hunter2hunter2");
    const { accessToken } = loggedIn.json<{ accessToken: string }>();
    return { id, email, accessToken };
  }

  it("returns the caller's own row and nothing else", async () => {
    const { id, email, accessToken } = await signedInUser();

    const response = await me(`Bearer ${accessToken}`);

    expect(response.statusCode).toBe(200);
    const body = response.json<Record<string, unknown>>();
    expect(Object.keys(body).sort()).toEqual(["createdAt", "email", "id"]);
    expect(body).toMatchObject({ id, email });
  });

  it("accepts the bearer scheme in lowercase", async () => {
    const { accessToken } = await signedInUser();

    const response = await me(`bearer ${accessToken}`);

    expect(response.statusCode).toBe(200);
  });

  it("rejects a request with no authorization header", async () => {
    const response = await me();

    expect(response.statusCode).toBe(401);
    expect(response.headers["www-authenticate"]).toBe("Bearer");
    expect(response.json<unknown>()).toEqual({ error: "missing_token" });
  });

  it("rejects a token that is not a jwt", async () => {
    const response = await me("Bearer not-a-token");

    expect(response.statusCode).toBe(401);
    expect(response.headers["www-authenticate"]).toBe('Bearer error="invalid_token"');
    expect(response.json<unknown>()).toEqual({ error: "invalid_token" });
  });

  it("tells the client a correctly signed but old token has expired", async () => {
    const { id } = await signedInUser();
    const issuedTooLongAgo = createAccessTokens(TEST_SECRET, {
      now: () => new Date(Date.now() - (DEFAULT_ACCESS_TOKEN_TTL_SECONDS + 60) * 1000),
    });
    const expired = await issuedTooLongAgo.issue(id);

    const response = await me(`Bearer ${expired}`);

    expect(response.statusCode).toBe(401);
    expect(response.json<unknown>()).toEqual({ error: "token_expired" });
  });

  it("rejects a still-valid token whose user no longer exists", async () => {
    const { id, accessToken } = await signedInUser();
    await db.delete(users).where(eq(users.id, id));

    const response = await me(`Bearer ${accessToken}`);

    expect(response.statusCode).toBe(401);
    expect(response.json<unknown>()).toEqual({ error: "invalid_token" });
  });
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
