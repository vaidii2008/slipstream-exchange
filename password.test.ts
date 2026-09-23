import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "./password.ts";

describe("hashPassword", () => {
  it("produces an argon2id phc string carrying the configured cost parameters", async () => {
    const digest = await hashPassword("correct horse battery staple");
    expect(digest.startsWith("$argon2id$v=19$m=19456,t=2,p=1$")).toBe(true);
  });

  it("produces a different digest each time for the same password", async () => {
    const first = await hashPassword("same password");
    const second = await hashPassword("same password");
    expect(first).not.toBe(second);
  });
});

describe("verifyPassword", () => {
  it("accepts the password the digest was created from", async () => {
    const digest = await hashPassword("s3cret-passphrase");
    await expect(verifyPassword(digest, "s3cret-passphrase")).resolves.toBe(true);
  });

  it("rejects a password that is one character short", async () => {
    const digest = await hashPassword("s3cret-passphrase");
    await expect(verifyPassword(digest, "s3cret-passphras")).resolves.toBe(false);
  });

  it("rejects a password differing only in case", async () => {
    const digest = await hashPassword("CaseSensitive");
    await expect(verifyPassword(digest, "casesensitive")).resolves.toBe(false);
  });
});
