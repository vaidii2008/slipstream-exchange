import { randomUUID } from "node:crypto";
import { STATUS_CODES } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import cookie from "@fastify/cookie";
import Fastify, { type FastifyError } from "fastify";
import { registerAuthRoutes, type AuthDependencies } from "./auth.ts";
import type { LogLevel } from "./config.ts";
import type { Exchange } from "./exchange.ts";
import { registerMarketDataRoutes } from "./market.ts";
import type { RateLimit } from "./ratelimit.ts";
import type { RedisClient } from "./redis.ts";
import { registerSessionRoutes } from "./sessions.ts";
import { registerTradingRoutes } from "./trading.ts";
import { registerWalletRoutes } from "./wallet.ts";
import { registerWebSocketRoutes } from "./ws.ts";

const HEALTH_CHECK_TIMEOUT_MS = 1000;

type PostgresProbe = {
  query: (sql: string) => Promise<unknown>;
};

export type ServerDependencies = AuthDependencies & {
  pool: PostgresProbe;
  redis: RedisClient;
  exchange: Exchange;
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
  // Per user, on POST /orders.
  orderRateLimit?: RateLimit;
};

export const DEFAULT_ORDER_RATE_LIMIT: RateLimit = { limit: 20, windowMs: 1000 };

export function buildServer(
  { pool, redis, db, tokens, exchange }: ServerDependencies,
  { logLevel, orderRateLimit = DEFAULT_ORDER_RATE_LIMIT }: ServerOptions = {},
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

  exchange.onHalt((market, error) => {
    app.log.fatal({ err: error, market }, "market halted: settlement failed after matching");
  });

  registerAuthRoutes(app, { db, tokens });
  registerSessionRoutes(app, { db, tokens });
  registerWalletRoutes(app, { db, tokens });
  registerTradingRoutes(app, { db, tokens, exchange, redis, orderRateLimit });
  registerMarketDataRoutes(app, { db, exchange });
  registerWebSocketRoutes(app, { db, exchange });

  return app;
}
