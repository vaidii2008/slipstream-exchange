import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { hitFixedWindow } from "./ratelimit.ts";
import { useTestServer } from "./testing.ts";

const { redis } = useTestServer();

const rule = { limit: 3, windowMs: 1000 };

// A key no other test or run shares, and a clock the test controls.
const freshKey = () => `test:ratelimit:${randomUUID()}`;
const WINDOW_START = 1_800_000_000_000;

describe("hitFixedWindow", () => {
  it("allows the limit within a window and refuses the next, saying when to retry", async () => {
    const key = freshKey();
    const at = WINDOW_START + 250;

    const verdicts = [];
    for (let hit = 0; hit < 4; hit++) {
      verdicts.push(await hitFixedWindow(redis, key, rule, at));
    }

    expect(verdicts).toEqual([
      { allowed: true },
      { allowed: true },
      { allowed: true },
      { allowed: false, retryAfterMs: 750 },
    ]);
  });

  it("starts a fresh count in the next window", async () => {
    const key = freshKey();
    for (let hit = 0; hit < 4; hit++) {
      await hitFixedWindow(redis, key, rule, WINDOW_START + 10);
    }

    await expect(hitFixedWindow(redis, key, rule, WINDOW_START + 1000)).resolves.toEqual({
      allowed: true,
    });
  });

  it("counts each key separately", async () => {
    const busy = freshKey();
    for (let hit = 0; hit < 4; hit++) {
      await hitFixedWindow(redis, busy, rule, WINDOW_START);
    }

    await expect(hitFixedWindow(redis, freshKey(), rule, WINDOW_START)).resolves.toEqual({
      allowed: true,
    });
  });

  // The weakness, written down: a full allowance at the end of one window and another at the
  // start of the next is 2 × limit within 2 ms.
  it("lets twice the limit through across a window boundary", async () => {
    const key = freshKey();
    const verdicts = [];
    for (let hit = 0; hit < 3; hit++) {
      verdicts.push(await hitFixedWindow(redis, key, rule, WINDOW_START + 999));
    }
    for (let hit = 0; hit < 3; hit++) {
      verdicts.push(await hitFixedWindow(redis, key, rule, WINDOW_START + 1000));
    }

    expect(verdicts.every((verdict) => verdict.allowed)).toBe(true);
  });

  it("leaves an expiry on the counter so idle keys disappear", async () => {
    const key = freshKey();
    await hitFixedWindow(redis, key, rule, Date.now());

    const [counter] = await redis.keys(`${key}:*`);
    expect(counter).toBeDefined();
    const ttl = await redis.pTTL(counter ?? "");
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(1000);
  });
});
