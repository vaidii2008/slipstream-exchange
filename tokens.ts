import { errors, jwtVerify, SignJWT } from "jose";

const ALGORITHM = "HS256";
const ISSUER = "slipstream";
const AUDIENCE = "slipstream-api";
const MIN_SECRET_BYTES = 32;

export const DEFAULT_ACCESS_TOKEN_TTL_SECONDS = 15 * 60;

export type AccessTokenVerification =
  { ok: true; userId: string; expiresAt: Date } | { ok: false; reason: "expired" | "invalid" };

export interface AccessTokens {
  issue(userId: string): Promise<string>;
  verify(token: string): Promise<AccessTokenVerification>;
}

export interface AccessTokenOptions {
  ttlSeconds?: number;
  now?: () => Date;
}

export function createAccessTokens(secret: string, options: AccessTokenOptions = {}): AccessTokens {
  const key = new TextEncoder().encode(secret);
  if (key.byteLength < MIN_SECRET_BYTES) {
    throw new Error(
      `access token secret must be at least ${MIN_SECRET_BYTES} bytes, got ${key.byteLength}`,
    );
  }

  const ttlSeconds = options.ttlSeconds ?? DEFAULT_ACCESS_TOKEN_TTL_SECONDS;
  if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0) {
    throw new Error(`access token ttl must be a positive integer, got ${ttlSeconds}`);
  }

  const now = options.now ?? (() => new Date());

  return {
    issue(userId: string): Promise<string> {
      const issuedAt = Math.floor(now().getTime() / 1000);
      return new SignJWT({})
        .setProtectedHeader({ alg: ALGORITHM, typ: "JWT" })
        .setSubject(userId)
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setIssuedAt(issuedAt)
        .setExpirationTime(issuedAt + ttlSeconds)
        .sign(key);
    },

    async verify(token: string): Promise<AccessTokenVerification> {
      try {
        const { payload } = await jwtVerify(token, key, {
          algorithms: [ALGORITHM],
          issuer: ISSUER,
          audience: AUDIENCE,
          currentDate: now(),
          requiredClaims: ["sub", "iat", "exp"],
        });
        if (typeof payload.sub !== "string" || payload.exp === undefined) {
          return { ok: false, reason: "invalid" };
        }
        return {
          ok: true,
          userId: payload.sub,
          expiresAt: new Date(payload.exp * 1000),
        };
      } catch (error) {
        if (error instanceof errors.JWTExpired) {
          return { ok: false, reason: "expired" };
        }
        if (error instanceof errors.JOSEError) {
          return { ok: false, reason: "invalid" };
        }
        throw error;
      }
    },
  };
}
