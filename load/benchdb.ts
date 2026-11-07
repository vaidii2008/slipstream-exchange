// The load test's own database, slipstream_bench, beside the dev one on the same Postgres. A
// run logs hundreds of thousands of commands, so it gets a database that is created for the
// run and dropped afterwards, and the dev event log never replays them.
//
//   node load/benchdb.ts create   creates and migrates it, then prints its URL
//   node load/benchdb.ts drop     drops it, disconnecting anything still attached

import { existsSync } from "node:fs";
import { Client } from "pg";
import { createAndMigrate } from "../testdb.ts";

if (existsSync(".env")) {
  process.loadEnvFile(".env");
}
const devUrl = process.env.DATABASE_URL;
if (devUrl === undefined) {
  throw new Error("DATABASE_URL is not set: add it to .env");
}
// Derived like slipstream_test's, so the bench can never be pointed at the dev database.
const benchUrl = new URL(devUrl);
benchUrl.pathname = `${benchUrl.pathname}_bench`;
const name = benchUrl.pathname.slice(1);

const action = process.argv[2];
if (action === "create") {
  await createAndMigrate(devUrl, benchUrl.toString());
  console.log(benchUrl.toString());
} else if (action === "drop") {
  const admin = new Client({ connectionString: devUrl });
  await admin.connect();
  try {
    // A name cannot be a bind parameter; it comes from our own DATABASE_URL, quoted.
    await admin.query(`drop database if exists "${name.replaceAll('"', '""')}" with (force)`);
    console.log(`dropped ${name}`);
  } finally {
    await admin.end();
  }
} else {
  throw new Error("usage: node load/benchdb.ts create|drop");
}
