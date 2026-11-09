import { randomUUID } from "node:crypto";
import { STATUS_CODES } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import Fastify, { type FastifyError } from "fastify";
import { registerAuthRoutes, type AuthDependencies } from "./auth.ts";
import { LiveCandles } from "./candles.ts";
import { DEFAULT_WEB_ORIGIN, type LogLevel } from "./config.ts";
import type { Exchange } from "./exchange.ts";
import { feedChannels, publishUpdate } from "./feed.ts";
import { registerMarketDataRoutes } from "./market.ts";
import { Metrics } from "./metrics.ts";
import { loadMarkets } from "./orders.ts";
import type { RateLimit } from "./ratelimit.ts";
import type { RedisClient } from "./redis.ts";
import { registerSessionRoutes } from "./sessions.ts";
import { registerTradingRoutes } from "./trading.ts";
import { registerWalletRoutes } from "./wallet.ts";
import { DEFAULT_WEBSOCKET_LIMITS, registerWebSocketRoutes, type WebSocketLimits } from "./ws.ts";

const HEALTH_CHECK_TIMEOUT_MS = 1000;

type PostgresProbe = {
  query: (sql: string) => Promise<unknown>;
};

export type ServerDependencies = AuthDependencies & {
  pool: PostgresProbe;
  redis: RedisClient;
  // A second connection, used only to subscribe to the market data feed.
  subscriber: RedisClient;
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
  // Prefix for the market data channels in Redis. Tests give each server its own.
  marketDataPrefix?: string;
  webSocketLimits?: WebSocketLimits;
  // The one browser origin allowed to call the API with credentials.
  webOrigin?: string;
  // Adds Node's own CPU, memory and event loop metrics to /metrics. Set by main.ts.
  processMetrics?: boolean;
};

export const DEFAULT_MARKET_DATA_PREFIX = "slipstream:";

export const DEFAULT_ORDER_RATE_LIMIT: RateLimit = { limit: 20, windowMs: 1000 };

export function buildServer(
  { pool, redis, subscriber, db, tokens, exchange }: ServerDependencies,
  {
    logLevel,
    orderRateLimit = DEFAULT_ORDER_RATE_LIMIT,
    marketDataPrefix = DEFAULT_MARKET_DATA_PREFIX,
    webSocketLimits = DEFAULT_WEBSOCKET_LIMITS,
    webOrigin = DEFAULT_WEB_ORIGIN,
    processMetrics = false,
  }: ServerOptions = {},
) {
  const app = Fastify({
    logger: logLevel === undefined ? false : { level: logLevel },
    // A UUID instead of Fastify's per-process counter, so ids stay unique across restarts.
    genReqId: () => randomUUID(),
  });

  void app.register(cookie);
  // The terminal is served from its own port, so every call it makes is cross-origin. Only
  // its origin is allowed, and with credentials, so the refresh cookie travels on
  // /session/refresh. A wildcard is not an option: browsers refuse credentials with "*". A
  // list, not a bare string, so another origin gets no allow header at all instead of ours.
  void app.register(cors, {
    origin: [webOrigin],
    credentials: true,
    methods: ["GET", "POST", "DELETE"],
  });

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

  const metrics = new Metrics();
  if (processMetrics) {
    metrics.collectProcessMetrics();
  }
  // Unauthenticated, like /health: Prometheus scrapes it without a token, and it holds counts
  // per market, nothing about any user. A deployment keeps it off the public listener.
  app.get("/metrics", async (_request, reply) => {
    return reply.type(metrics.registry.contentType).send(await metrics.registry.metrics());
  });

  exchange.onHalt((market, error) => {
    // The error says why: a failed settlement, a log that did not replay, or a lock another
    // process holds or this one lost.
    app.log.fatal({ err: error, market }, "market halted");
  });
  exchange.onSnapshot((market, sequence, error) => {
    if (error === undefined) {
      app.log.info({ market, sequence }, "book snapshot written");
    } else {
      // Not fatal: the market trades on, and its next boot replays further back.
      app.log.error({ err: error, market, sequence }, "book snapshot write failed");
    }
  });

  registerAuthRoutes(app, { db, tokens });
  registerSessionRoutes(app, { db, tokens });
  const channels = feedChannels(marketDataPrefix);
  registerWalletRoutes(app, { db, tokens, redis, channels });
  registerTradingRoutes(app, { db, tokens, exchange, redis, orderRateLimit, metrics });
  registerMarketDataRoutes(app, { db, exchange });
  const candles = new LiveCandles();
  // onReady runs before the server accepts a request, so before any trade can settle.
  app.addHook("onReady", async () => {
    await candles.load(db, [...(await loadMarkets(db)).values()]);
  });
  const stopPublishing = exchange.onUpdate((update) => {
    metrics.settled(update);
    publishUpdate(redis, channels, candles, update, app.log);
  });
  app.addHook("onClose", (_instance, done) => {
    stopPublishing();
    done();
  });
  registerWebSocketRoutes(app, {
    db,
    exchange,
    tokens,
    subscriber,
    channels,
    limits: webSocketLimits,
    metrics,
  });

  return app;
}
