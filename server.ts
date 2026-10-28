import { randomUUID } from "node:crypto";
import { STATUS_CODES } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import cookie from "@fastify/cookie";
import Fastify, { type FastifyError } from "fastify";
import { registerAuthRoutes, type AuthDependencies } from "./auth.ts";
import type { LogLevel } from "./config.ts";
import { registerSessionRoutes } from "./sessions.ts";

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

// 400 matches the code the auth routes already use for a body that fails validation.
function errorCodeFor(statusCode: number): string {
  if (statusCode === 400) {
    return "invalid_request";
  }
  const reason = STATUS_CODES[statusCode] ?? "request error";
  return reason.toLowerCase().replaceAll(/[^a-z]+/g, "_");
}

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

export type ServerOptions = {
  // Left unset in tests so the suite output stays readable.
  logLevel?: LogLevel;
};

export function buildServer(
  { pool, redis, db, tokens }: ServerDependencies,
  { logLevel }: ServerOptions = {},
) {
  const app = Fastify({
    logger: logLevel === undefined ? false : { level: logLevel },
    // A UUID instead of Fastify's per-process counter, so ids stay unique across restarts.
    genReqId: () => randomUUID(),
  });

  void app.register(cookie);

  app.setErrorHandler((error: FastifyError, request, reply) => {
    const statusCode = error.statusCode ?? 500;

    if (statusCode >= 400 && statusCode < 500) {
      // Fastify's own 4xx errors (bad JSON, wrong content type, body too large) describe the
      // client's mistake, so the message is safe to return.
      request.log.info({ err: error }, "client error");
      return reply
        .code(statusCode)
        .send({ error: errorCodeFor(statusCode), message: error.message });
    }

    // Anything else is our bug: a driver error here can carry SQL or stored values, so the
    // client gets a bare code and the detail goes only to the log, under this request's id.
    request.log.error({ err: error }, "unhandled error");
    return reply.code(500).send({ error: "internal_error" });
  });

  app.setNotFoundHandler((_request, reply) => {
    return reply.code(404).send({ error: "not_found" });
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
  registerSessionRoutes(app, { db, tokens });

  return app;
}
