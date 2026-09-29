import { setTimeout as delay } from "node:timers/promises";
import Fastify from "fastify";
import { registerAuthRoutes, type AuthDependencies } from "./auth.ts";

const HEALTH_CHECK_TIMEOUT_MS = 1000;

type PostgresProbe = {
  query: (sql: string) => Promise<unknown>;
};

type RedisProbe = {
  ping: () => Promise<unknown>;
};

export type ServerDependencies = AuthDependencies & {
  pool: PostgresProbe;
  redis: RedisProbe;
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

export function buildServer({ pool, redis, db, tokens }: ServerDependencies) {
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

  registerAuthRoutes(app, { db, tokens });

  return app;
}
