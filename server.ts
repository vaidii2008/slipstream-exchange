import { setTimeout as delay } from "node:timers/promises";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import Fastify from "fastify";
import { z } from "zod";
import { hashPassword } from "./password.ts";
import { users } from "./schema.ts";

const HEALTH_CHECK_TIMEOUT_MS = 1000;
const UNIQUE_VIOLATION = "23505";

type PostgresProbe = {
  query: (sql: string) => Promise<unknown>;
};

type RedisProbe = {
  ping: () => Promise<unknown>;
};

export type ServerDependencies = {
  pool: PostgresProbe;
  redis: RedisProbe;
  db: NodePgDatabase;
};

const registerBody = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email().max(254)),
  password: z.string().min(8).max(256),
});

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

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && "code" in error && error.code === UNIQUE_VIOLATION
  );
}

export function buildServer({ pool, redis, db }: ServerDependencies) {
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

  app.post("/register", async (request, reply) => {
    const parsed = registerBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "invalid_request",
        issues: parsed.error.issues.map((issue) => ({
          field: issue.path.join("."),
          message: issue.message,
        })),
      });
    }

    const passwordHash = await hashPassword(parsed.data.password);

    try {
      const [created] = await db
        .insert(users)
        .values({ email: parsed.data.email, passwordHash })
        .returning({ id: users.id, email: users.email, createdAt: users.createdAt });

      if (created === undefined) {
        throw new Error("register insert returned no row");
      }

      return reply.code(201).send(created);
    } catch (error) {
      if (isUniqueViolation(error)) {
        return reply.code(409).send({ error: "email_already_registered" });
      }
      throw error;
    }
  });

  return app;
}