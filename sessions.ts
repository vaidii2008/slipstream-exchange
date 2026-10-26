import { randomUUID } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { FastifyInstance, FastifyReply } from "fastify";
import { refreshTokens } from "./schema.ts";
import {
  generateRefreshToken,
  hashRefreshToken,
  REFRESH_TOKEN_TTL_SECONDS,
  type AccessTokens,
} from "./tokens.ts";

const REFRESH_COOKIE = "slipstream_refresh";
const REFRESH_COOKIE_PATH = "/session";

export type SessionDependencies = {
  db: NodePgDatabase;
  tokens: AccessTokens;
};

type RotatedSession = {
  userId: string;
  token: string;
};

function refreshExpiry(from: Date): Date {
  return new Date(from.getTime() + REFRESH_TOKEN_TTL_SECONDS * 1000);
}

export async function startSession(db: NodePgDatabase, userId: string): Promise<string> {
  const refresh = generateRefreshToken();
  await db.insert(refreshTokens).values({
    userId,
    familyId: randomUUID(),
    tokenHash: refresh.tokenHash,
    expiresAt: refreshExpiry(new Date()),
  });
  return refresh.token;
}

export function rotateSession(
  db: NodePgDatabase,
  presentedToken: string,
): Promise<RotatedSession | undefined> {
  const presentedHash = hashRefreshToken(presentedToken);
  const next = generateRefreshToken();

  return db.transaction(async (tx) => {
    const now = new Date();
    const [consumed] = await tx
      .update(refreshTokens)
      .set({ usedAt: now })
      .where(
        and(
          eq(refreshTokens.tokenHash, presentedHash),
          isNull(refreshTokens.usedAt),
          isNull(refreshTokens.revokedAt),
          gt(refreshTokens.expiresAt, now),
        ),
      )
      .returning({ userId: refreshTokens.userId, familyId: refreshTokens.familyId });

    if (consumed === undefined) {
      return undefined;
    }

    await tx.insert(refreshTokens).values({
      userId: consumed.userId,
      familyId: consumed.familyId,
      tokenHash: next.tokenHash,
      expiresAt: refreshExpiry(now),
    });

    return { userId: consumed.userId, token: next.token };
  });
}

export function setRefreshCookie(reply: FastifyReply, token: string): FastifyReply {
  return reply.setCookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: "strict",
    path: REFRESH_COOKIE_PATH,
    maxAge: REFRESH_TOKEN_TTL_SECONDS,
  });
}

export function registerSessionRoutes(
  app: FastifyInstance,
  { db, tokens }: SessionDependencies,
): void {
  app.post("/session/refresh", async (request, reply) => {
    const presented = request.cookies[REFRESH_COOKIE];
    if (presented === undefined) {
      return reply.code(401).send({ error: "missing_refresh_token" });
    }

    const rotated = await rotateSession(db, presented);
    if (rotated === undefined) {
      return reply.code(401).send({ error: "invalid_refresh_token" });
    }

    const accessToken = await tokens.issue(rotated.userId);
    return setRefreshCookie(reply.code(200), rotated.token).send({
      accessToken,
      tokenType: "Bearer",
    });
  });
}
