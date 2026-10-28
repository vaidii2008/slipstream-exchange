import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { refreshTokens, users } from "./schema.ts";
import { buildServer } from "./server.ts";
import { createAccessTokens, hashRefreshToken } from "./tokens.ts";

if (existsSync(".env")) {
  process.loadEnvFile(".env");
}

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) {
  throw new Error("DATABASE_URL is not set: these tests talk to a real postgres");
}

const REFRESH_COOKIE = "slipstream_refresh";

const pool = new Pool({ connectionString: databaseUrl });
const db = drizzle({ client: pool });
const tokens = createAccessTokens("s".repeat(32));
const app = buildServer({
  pool,
  redis: { ping: () => Promise.resolve("PONG") },
  db,
  tokens,
});

const createdEmails: string[] = [];

type Response = Awaited<ReturnType<typeof app.inject>>;

function refreshCookieOf(response: Response): string {
  const cookie = response.cookies.find((candidate) => candidate.name === REFRESH_COOKIE);
  if (cookie === undefined) {
    throw new Error(`response set no ${REFRESH_COOKIE} cookie`);
  }
  return cookie.value;
}

async function signedInUser(): Promise<{ userId: string; refreshToken: string }> {
  const email = `session-test-${randomUUID()}@slipstream.test`;
  createdEmails.push(email);

  const registered = await app.inject({
    method: "POST",
    url: "/register",
    payload: { email, password: "hunter2hunter2" },
  });
  const { id } = registered.json<{ id: string }>();

  const loggedIn = await app.inject({
    method: "POST",
    url: "/login",
    payload: { email, password: "hunter2hunter2" },
  });
  return { userId: id, refreshToken: refreshCookieOf(loggedIn) };
}

function refresh(token?: string) {
  return app.inject({
    method: "POST",
    url: "/session/refresh",
    cookies: token === undefined ? {} : { [REFRESH_COOKIE]: token },
  });
}

function logout(token?: string) {
  return app.inject({
    method: "POST",
    url: "/session/logout",
    cookies: token === undefined ? {} : { [REFRESH_COOKIE]: token },
  });
}

function sessionRows(userId: string) {
  return db
    .select({
      familyId: refreshTokens.familyId,
      tokenHash: refreshTokens.tokenHash,
      usedAt: refreshTokens.usedAt,
      revokedAt: refreshTokens.revokedAt,
    })
    .from(refreshTokens)
    .where(eq(refreshTokens.userId, userId));
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

describe("POST /session/refresh", () => {
  it("swaps a valid refresh token for a new access token and a new refresh token", async () => {
    const { userId, refreshToken } = await signedInUser();

    const response = await refresh(refreshToken);

    expect(response.statusCode).toBe(200);
    const body = response.json<{ accessToken: string; tokenType: string }>();
    expect(body.tokenType).toBe("Bearer");
    await expect(tokens.verify(body.accessToken)).resolves.toMatchObject({ ok: true, userId });

    const rotated = refreshCookieOf(response);
    expect(rotated).not.toBe(refreshToken);

    const rows = await sessionRows(userId);
    expect(rows).toHaveLength(2);
    const old = rows.find((row) => row.tokenHash === hashRefreshToken(refreshToken));
    const next = rows.find((row) => row.tokenHash === hashRefreshToken(rotated));
    expect(old?.usedAt).toBeInstanceOf(Date);
    expect(next).toMatchObject({ familyId: old?.familyId, usedAt: null, revokedAt: null });
  });

  it("keeps rotating down the same family", async () => {
    const { userId, refreshToken } = await signedInUser();

    const first = await refresh(refreshToken);
    const second = await refresh(refreshCookieOf(first));
    const third = await refresh(refreshCookieOf(second));

    expect([first, second, third].map((response) => response.statusCode)).toEqual([200, 200, 200]);
    const families = new Set((await sessionRows(userId)).map((row) => row.familyId));
    expect(families.size).toBe(1);
  });

  it("rejects a request with no refresh cookie", async () => {
    const response = await refresh();

    expect(response.statusCode).toBe(401);
    expect(response.json<unknown>()).toEqual({ error: "missing_refresh_token" });
  });

  it("rejects a token it never issued", async () => {
    const response = await refresh("not-a-token-we-issued");

    expect(response.statusCode).toBe(401);
    expect(response.json<unknown>()).toEqual({ error: "invalid_refresh_token" });
  });

  it("rejects an expired token without revoking its family", async () => {
    const { userId, refreshToken } = await signedInUser();
    await db
      .update(refreshTokens)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(refreshTokens.tokenHash, hashRefreshToken(refreshToken)));

    const response = await refresh(refreshToken);

    expect(response.statusCode).toBe(401);
    expect(response.json<unknown>()).toEqual({ error: "invalid_refresh_token" });
    const rows = await sessionRows(userId);
    expect(rows.every((row) => row.revokedAt === null)).toBe(true);
  });
});

describe("refresh token reuse detection", () => {
  it("revokes the whole family when a used token is presented again", async () => {
    const { userId, refreshToken } = await signedInUser();
    const rotated = refreshCookieOf(await refresh(refreshToken));

    const replay = await refresh(refreshToken);

    expect(replay.statusCode).toBe(401);
    expect(replay.json<unknown>()).toEqual({ error: "invalid_refresh_token" });
    const rows = await sessionRows(userId);
    expect(rows.every((row) => row.revokedAt !== null)).toBe(true);

    const legitimate = await refresh(rotated);
    expect(legitimate.statusCode).toBe(401);
  });

  it("leaves the user's other sessions alone", async () => {
    const { userId, refreshToken } = await signedInUser();
    const [user] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId));
    const otherDevice = await app.inject({
      method: "POST",
      url: "/login",
      payload: { email: user?.email, password: "hunter2hunter2" },
    });
    const otherToken = refreshCookieOf(otherDevice);

    await refresh(refreshToken);
    await refresh(refreshToken);

    const response = await refresh(otherToken);
    expect(response.statusCode).toBe(200);
  });

  it("lets one of two concurrent refreshes win and treats the loser as reuse", async () => {
    const { userId, refreshToken } = await signedInUser();

    const responses = await Promise.all([refresh(refreshToken), refresh(refreshToken)]);

    const statuses = responses.map((response) => response.statusCode).sort((a, b) => a - b);
    expect(statuses).toEqual([200, 401]);
    const rows = await sessionRows(userId);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.revokedAt !== null)).toBe(true);
  });
});

describe("POST /session/logout", () => {
  it("revokes the family, clears the cookie and answers 204", async () => {
    const { userId, refreshToken } = await signedInUser();

    const response = await logout(refreshToken);

    expect(response.statusCode).toBe(204);
    const cleared = response.cookies.find((candidate) => candidate.name === REFRESH_COOKIE);
    expect(cleared).toMatchObject({ value: "", path: "/session" });
    const rows = await sessionRows(userId);
    expect(rows.every((row) => row.revokedAt !== null)).toBe(true);

    const afterLogout = await refresh(refreshToken);
    expect(afterLogout.statusCode).toBe(401);
  });

  it("revokes the current token when given an older token from the same family", async () => {
    const { refreshToken } = await signedInUser();
    const rotated = refreshCookieOf(await refresh(refreshToken));

    await logout(refreshToken);

    const response = await refresh(rotated);
    expect(response.statusCode).toBe(401);
  });

  it("answers 204 with no cookie at all", async () => {
    const response = await logout();

    expect(response.statusCode).toBe(204);
  });
});
