import { randomUUID } from "node:crypto";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { FastifyReply } from "fastify";
import { refreshTokens } from "./schema.ts";
import { generateRefreshToken, REFRESH_TOKEN_TTL_SECONDS } from "./tokens.ts";

const REFRESH_COOKIE = "slipstream_refresh";
const REFRESH_COOKIE_PATH = "/session";

export async function startSession(db: NodePgDatabase, userId: string): Promise<string> {
  const refresh = generateRefreshToken();
  await db.insert(refreshTokens).values({
    userId,
    familyId: randomUUID(),
    tokenHash: refresh.tokenHash,
    expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000),
  });
  return refresh.token;
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
