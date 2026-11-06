// Fixed-window rate limiting on Redis. Time is cut into windows of `windowMs`; each key gets a
// counter per window, and a hit past `limit` in the same window is refused.
//
// The known weakness: the windows are fixed, so a client can spend a full window's allowance
// at the very end of one window and again at the start of the next, up to 2 × limit within a
// span of a few milliseconds. A sliding window or token bucket would close that gap at the
// cost of more Redis work per hit; here the limit is a brake on a runaway client, and the
// per-market queue cap stops overload whatever the limiter lets through.

import type { RedisClient } from "./redis.ts";

export type RateLimit = { limit: number; windowMs: number };

// A connected but slow Redis still answers eventually, so the offline queue setting does not
// help; the caller gives up after this long and treats the limit as unavailable.
export const RATE_LIMIT_TIMEOUT_MS = 100;

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
  // disableOfflineQueue only covers single commands: node-redis 6 queues a MULTI while
  // reconnecting regardless. Refusing here keeps an outage from piling up queued MULTIs that
  // the timeout below would abandon but never remove.
  if (!redis.isReady) {
    throw new Error("rate limit unavailable: redis is not connected");
  }
  const reply = redis.multi().incr(windowKey).pExpire(windowKey, windowMs, "NX").exec();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`rate limit check timed out after ${RATE_LIMIT_TIMEOUT_MS} ms`));
    }, RATE_LIMIT_TIMEOUT_MS);
  });
  let count;
  try {
    // A reply that arrives after the timeout is dropped. Promise.race has already attached a
    // handler to it, so a late rejection is not unhandled.
    [count] = await Promise.race([reply, timeout]);
  } finally {
    clearTimeout(timer);
  }
  if (typeof count !== "number") {
    throw new Error(`INCR on ${windowKey} returned ${JSON.stringify(count)}`);
  }

  if (count <= limit) {
    return { allowed: true };
  }
  return { allowed: false, retryAfterMs: (window + 1) * windowMs - now };
}
