import { setTimeout as delay } from "node:timers/promises";
import Fastify from "fastify";
import { Pool } from "pg";
import { createClient } from "redis";
import { parseConfig } from "./config.ts";

const HEALTH_CHECK_TIMEOUT_MS = 1000;

type Dependencies = {
  pool: Pool;
  redis: ReturnType<typeof createRedisClient>;
};

async function probe(check: () => Promise<unknown>): Promise<"up" | "down"> {
  try {
    await Promise.race([
      check(),
      delay(HEALTH_CHECK_TIMEOUT_MS, undefined, { ref: false }).then(() => {
        throw new Error("health check timed out");
      }),
    ]);
    return "up";
  } catch {
    return "down";
  }
}

export function buildServer({ pool, redis }: Dependencies) {
  const app = Fastify({
    logger: false,
  });

  app.get("/health", async (_request, reply) => {
    const [postgres, redisStatus] = await Promise.all([
      probe(() => pool.query("select 1")),
      probe(() => redis.ping()),
    ]);
    const healthy = postgres === "up" && redisStatus === "up";

    return reply.code(healthy ? 200 : 503).send({
      status: healthy ? "ok" : "degraded",
      checks: { postgres, redis: redisStatus },
    });
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

function createRedisClient(url: string) {
  let hasConnected = false;
  const client = createClient({
    url,
    socket: {
      connectTimeout: 5000,
      reconnectStrategy: (retries, cause) => (hasConnected ? Math.min(retries * 200, 2000) : cause),
    },
  });
  client.on("ready", () => {
    hasConnected = true;
  });
  client.on("error", (error) => {
    console.error(`redis client error: ${error instanceof Error ? error.message : String(error)}`);
  });
  return client;
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

  const redis = createRedisClient(config.REDIS_URL);
  await verifyRedis(redis);
  console.log("redis connection verified");

  const app = buildServer({ pool, redis });
  await app.listen({ port: config.PORT, host: "0.0.0.0" });
  console.log(`slipstream api listening on http://localhost:${config.PORT}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
