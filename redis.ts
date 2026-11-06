// The API's Redis client, built the same way wherever the process or a test needs one.

import { createClient, type RedisClientType } from "redis";

export type RedisClient = RedisClientType;

// Fails fast if Redis is down at startup; once connected, reconnects with backoff forever.
//
// No offline queue: while the client is reconnecting, a command is rejected at once instead
// of waiting for Redis to come back. With the queue, every command issued during an outage
// waited, unbounded in time and in number, and POST /orders hung behind the rate limiter.
export function createRedisClient(url: string) {
  let hasConnected = false;
  const client = createClient({
    url,
    disableOfflineQueue: true,
    socket: {
      connectTimeout: 5000,
      reconnectStrategy: (retries, cause) => (hasConnected ? Math.min(retries * 200, 2000) : cause),
    },
  });
  client.on("ready", () => {
    hasConnected = true;
  });
  return client;
}
