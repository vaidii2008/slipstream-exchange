import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { users } from "./schema.ts";
import { buildServer } from "./server.ts";

if (existsSync(".env")) {
  process.loadEnvFile(".env");
}

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) {
  throw new Error("DATABASE_URL is not set: these tests talk to a real postgres");
}

const pool = new Pool({ connectionString: databaseUrl });
const db = drizzle({ client: pool });
const app = buildServer({
  pool,
  redis: { ping: () => Promise.resolve("PONG") },
  db,
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
