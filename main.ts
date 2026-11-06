import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { parseConfig } from "./config.ts";
import { Exchange } from "./exchange.ts";
import { createRedisClient } from "./redis.ts";
import { buildServer } from "./server.ts";
import { createAccessTokens } from "./tokens.ts";

async function verifyPostgres(pool: Pool): Promise<void> {
  try {
    await pool.query("select 1");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`postgres is unreachable: ${reason}`, { cause: error });
  }
}

async function verifyRedis(redis: ReturnType<typeof createRedisClient>): Promise<void> {
  try {
    await redis.connect();
    await redis.ping();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`redis is unreachable: ${reason}`, { cause: error });
  }
}

const SHUTDOWN_TIMEOUT_MS = 10_000;

let app: ReturnType<typeof buildServer> | undefined;

function shutDownOn(signal: NodeJS.Signals, server: ReturnType<typeof buildServer>): void {
  process.once(signal, () => {
    server.log.info({ signal }, "shutting down");

    // A request that never finishes must not keep the process alive past the
    // orchestrator's own kill timeout, so give up and exit non-zero instead.
    setTimeout(() => {
      server.log.error({ timeoutMs: SHUTDOWN_TIMEOUT_MS }, "shutdown timed out");
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS).unref();

    server.close().then(
      () => {
        server.log.info("shutdown complete");
        process.exit(0);
      },
      (error: unknown) => {
        server.log.error({ err: error }, "shutdown failed");
        process.exit(1);
      },
    );
  });
}

try {
  const config = parseConfig(process.env);
  const tokens = createAccessTokens(config.JWT_ACCESS_SECRET);

  const pool = new Pool({
    connectionString: config.DATABASE_URL,
    connectionTimeoutMillis: 5000,
  });
  const redis = createRedisClient(config.REDIS_URL);
  // Same options; a connection in subscribe mode can run nothing else.
  const subscriber = redis.duplicate();
  const db = drizzle({ client: pool });

  // Built before the connections are verified so every startup line goes through pino.
  app = buildServer(
    { pool, redis, subscriber, db, tokens, exchange: new Exchange(db) },
    {
      logLevel: config.LOG_LEVEL,
      orderRateLimit: { limit: config.ORDER_RATE_LIMIT, windowMs: 1000 },
      webOrigin: config.WEB_ORIGIN,
    },
  );
  const log = app.log;

  pool.on("error", (error) => {
    log.error({ err: error }, "postgres pool error");
  });
  redis.on("error", (error: unknown) => {
    log.error({ err: error }, "redis client error");
  });
  subscriber.on("error", (error: unknown) => {
    log.error({ err: error }, "redis subscriber error");
  });

  // app.close() stops accepting connections and waits for in-flight requests before
  // running onClose, so no request loses its database halfway through.
  app.addHook("onClose", async () => {
    await Promise.all([
      redis.isOpen ? redis.close() : undefined,
      subscriber.isOpen ? subscriber.close() : undefined,
      pool.end(),
    ]);
  });
  shutDownOn("SIGTERM", app);
  shutDownOn("SIGINT", app);

  await verifyPostgres(pool);
  log.info("postgres connection verified");

  await verifyRedis(redis);
  await verifyRedis(subscriber);
  log.info("redis connections verified");

  await app.listen({ port: config.PORT, host: "0.0.0.0" });
} catch (error) {
  if (app === undefined) {
    // Config failed to parse, so there is no logger yet.
    console.error(error instanceof Error ? error.message : error);
  } else {
    app.log.fatal({ err: error }, "startup failed");
  }
  process.exit(1);
}
