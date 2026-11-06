// Fixed-window rate limiting on Redis. Time is cut into windows of `windowMs`; each key gets a
// counter per window, and a hit past `limit` in the same window is refused.
//
// The known weakness: the windows are fixed, so a client can spend a full window's allowance
// at the very end of one window and again at the start of the next, up to 2 × limit within a
// span of a few milliseconds. A sliding window or token bucket would close that gap at the
// cost of more Redis work per hit; here the limit is a brake on a runaway client, and the
// per-market queue cap stops overload whatever the limiter lets through.

import type { RedisClientType } from "redis";

export type RedisClient = RedisClientType;

export type RateLimit = { limit: number; windowMs: number };

export type RateLimitVerdict = { allowed: true } | { allowed: false; retryAfterMs: number };

export async function hitFixedWindow(
  redis: RedisClient,
  key: string,
  { limit, windowMs }: RateLimit,
  now = Date.now(),
): Promise<RateLimitVerdict> {
  const window = Math.floor(now / windowMs);
  const windowKey = `${key}:${window}`;

  // One round trip, applied together. The expiry only cleans up: the window number in the key
  // is what starts a fresh count. NX keeps later hits from pushing the expiry back.
  const [count] = await redis.multi().incr(windowKey).pExpire(windowKey, windowMs, "NX").exec();
  if (typeof count !== "number") {
    throw new Error(`INCR on ${windowKey} returned ${JSON.stringify(count)}`);
  }

  if (count <= limit) {
    return { allowed: true };
  }
  return { allowed: false, retryAfterMs: (window + 1) * windowMs - now };
}
