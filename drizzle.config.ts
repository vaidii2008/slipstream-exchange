import { existsSync } from "node:fs";
import { defineConfig } from "drizzle-kit";

if (existsSync(".env")) {
  process.loadEnvFile(".env");
}

const url = process.env.DATABASE_URL;
if (url === undefined) {
  throw new Error(
    "DATABASE_URL is not set: add it to .env or export it before running drizzle-kit",
  );
}

export default defineConfig({
  dialect: "postgresql",
  schema: "./schema.ts",
  out: "./drizzle",
  dbCredentials: { url },
});
