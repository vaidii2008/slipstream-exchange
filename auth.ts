import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { hashPassword, verifyPassword } from "./password.ts";
import { users } from "./schema.ts";
import type { AccessTokens } from "./tokens.ts";

const UNIQUE_VIOLATION = "23505";
const MAX_CAUSE_DEPTH = 5;
const TIMING_DUMMY_PASSWORD = "slipstream-login-timing-dummy";

export type AuthDependencies = {
  db: NodePgDatabase;
  tokens: AccessTokens;
};

const registerBody = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email().max(254)),
  password: z.string().min(8).max(256),
});

const loginBody = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email().max(254)),
  password: z.string().min(1).max(256),
});

function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;

  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (typeof current !== "object" || current === null) {
      return false;
    }
    if ("code" in current && current.code === UNIQUE_VIOLATION) {
      return true;
    }
    if (!("cause" in current)) {
      return false;
    }
    current = current.cause;
  }

  return false;
}

export function registerAuthRoutes(app: FastifyInstance, { db, tokens }: AuthDependencies): void {
  let timingDummyHash: Promise<string> | undefined;

  async function verifyAgainstDummy(password: string): Promise<void> {
    timingDummyHash ??= hashPassword(TIMING_DUMMY_PASSWORD);
    await verifyPassword(await timingDummyHash, password);
  }

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

  app.post("/login", async (request, reply) => {
    const parsed = loginBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "invalid_request",
        issues: parsed.error.issues.map((issue) => ({
          field: issue.path.join("."),
          message: issue.message,
        })),
      });
    }

    const [user] = await db
      .select({ id: users.id, passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.email, parsed.data.email))
      .limit(1);

    if (user === undefined) {
      await verifyAgainstDummy(parsed.data.password);
      return reply.code(401).send({ error: "invalid_credentials" });
    }

    const passwordMatches = await verifyPassword(user.passwordHash, parsed.data.password);
    if (!passwordMatches) {
      return reply.code(401).send({ error: "invalid_credentials" });
    }

    const accessToken = await tokens.issue(user.id);
    return reply.code(200).send({ accessToken, tokenType: "Bearer" });
  });
}
