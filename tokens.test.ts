import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createAccessTokens } from "./tokens.ts";

const SECRET = "a".repeat(32);

function segments(token: string): [string, string, string] {
  const parts = token.split(".");
  const [header, payload, signature] = parts;
  if (
    parts.length !== 3 ||
    header === undefined ||
    payload === undefined ||
    signature === undefined
  ) {
    throw new Error(`expected three token segments, got ${parts.length}`);
  }
  return [header, payload, signature];
}

function base64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

type Claims = Record<string, unknown>;

function decodePayload(token: string): Claims {
  const [, payload] = segments(token);
  const json = Buffer.from(payload, "base64url").toString("utf8");
  return JSON.parse(json) as Claims;
}

describe("createAccessTokens", () => {
  it("rejects a secret shorter than 32 bytes", () => {
    expect(() => createAccessTokens("too-short")).toThrow(/at least 32 bytes/);
  });

  it("verifies a token it issued and returns the user id", async () => {
    const tokens = createAccessTokens(SECRET);
    const userId = randomUUID();
    const result = await tokens.verify(await tokens.issue(userId));
    expect(result).toMatchObject({ ok: true, userId });
  });

  it("carries only the standard claims and nothing about the user", async () => {
    const tokens = createAccessTokens(SECRET);
    const payload = decodePayload(await tokens.issue(randomUUID()));
    expect(Object.keys(payload).sort()).toEqual(["aud", "exp", "iat", "iss", "sub"]);
  });

  it("is valid one second before expiry and expired at expiry", async () => {
    let current = new Date("2026-09-27T12:00:00Z");
    const tokens = createAccessTokens(SECRET, {
      ttlSeconds: 900,
      now: () => current,
    });
    const userId = randomUUID();
    const token = await tokens.issue(userId);

    current = new Date("2026-09-27T12:14:59Z");
    expect(await tokens.verify(token)).toEqual({
      ok: true,
      userId,
      expiresAt: new Date("2026-09-27T12:15:00Z"),
    });

    current = new Date("2026-09-27T12:15:00Z");
    expect(await tokens.verify(token)).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("rejects a token signed with a different secret", async () => {
    const issuer = createAccessTokens("b".repeat(32));
    const verifier = createAccessTokens(SECRET);
    const token = await issuer.issue(randomUUID());
    expect(await verifier.verify(token)).toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  it("rejects a token whose payload was edited after signing", async () => {
    const tokens = createAccessTokens(SECRET);
    const token = await tokens.issue(randomUUID());
    const [header, , signature] = segments(token);
    const forged = { ...decodePayload(token), sub: randomUUID() };
    const tampered = `${header}.${base64url(forged)}.${signature}`;
    expect(await tokens.verify(tampered)).toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  it("rejects an unsigned token claiming alg none", async () => {
    const tokens = createAccessTokens(SECRET);
    const issuedAt = Math.floor(Date.now() / 1000);
    const header = base64url({ alg: "none", typ: "JWT" });
    const payload = base64url({
      sub: randomUUID(),
      iss: "slipstream",
      aud: "slipstream-api",
      iat: issuedAt,
      exp: issuedAt + 900,
    });
    expect(await tokens.verify(`${header}.${payload}.`)).toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  it("rejects a string that is not a jwt", async () => {
    const tokens = createAccessTokens(SECRET);
    expect(await tokens.verify("not-a-token")).toEqual({
      ok: false,
      reason: "invalid",
    });
  });
});
