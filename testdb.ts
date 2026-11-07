// The test suite's own database, next to the dev one on the same Postgres. Tests write
// trades, orders and event-log rows, so sharing the dev database let a test run move live
// bots' prices and let live trades leak into test assertions.

import { existsSync } from "node:fs";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client } from "pg";

// DATABASE_URL with `_test` appended to the database name: slipstream becomes slipstream_test.
// Derived rather than configured, so a test run can never be pointed at the dev database.
export function testDatabaseUrl(): string {
  if (existsSync(".env")) {
    process.loadEnvFile(".env");
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined) {
    throw new Error("DATABASE_URL is not set: these tests talk to a real postgres");
  }
  const url = new URL(databaseUrl);
  url.pathname = `${url.pathname}_test`;
  return url.toString();
}

// Vitest's global setup: runs once, before any test file opens a connection. Creates the test
// database if it is missing, then applies every migration drizzle-kit generated.
export async function setup(): Promise<void> {
  const testUrl = testDatabaseUrl();
  const name = new URL(testUrl).pathname.slice(1);

  // CREATE DATABASE runs from a connection to another database on the same server.
  const admin = new Client({ connectionString: process.env.DATABASE_URL });
  try {
    await admin.connect();
  } catch (error) {
    throw new Error("cannot reach postgres: run `docker compose up -d --wait` first", {
      cause: error,
    });
  }
  try {
    const existing = await admin.query("select 1 from pg_database where datname = $1", [name]);
    if (existing.rowCount === 0) {
      // A name cannot be a bind parameter; it comes from our own DATABASE_URL, quoted.
      await admin.query(`create database "${name.replaceAll('"', '""')}"`);
    }
  } finally {
    await admin.end();
  }

  const client = new Client({ connectionString: testUrl });
  await client.connect();
  try {
    await migrate(drizzle({ client }), { migrationsFolder: "./drizzle" });
  } finally {
    await client.end();
  }
}
