import Fastify from "fastify";
import { Pool } from "pg";
import { parseConfig } from "./config.ts";

export function buildServer() {
  const app = Fastify({
    logger: false,
  });

  app.get("/health", () => {
    return { status: "ok" };
  });

  return app;
}

async function verifyPostgres(pool: Pool): Promise<void> {
  try {
    await pool.query("select 1");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`postgres is unreachable: ${reason}`, { cause: error });
  }
}

try {
  const config = parseConfig(process.env);

  const pool = new Pool({
    connectionString: config.DATABASE_URL,
    connectionTimeoutMillis: 5000,
  });
  pool.on("error", (error) => {
    console.error(`postgres pool error: ${error.message}`);
  });

  await verifyPostgres(pool);
  console.log("postgres connection verified");

  const app = buildServer();
  await app.listen({ port: config.PORT, host: "0.0.0.0" });
  console.log(`slipstream api listening on http://localhost:${config.PORT}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
