// The API's Redis client, built the same way wherever the process or a test needs one.

import { createClient, type RedisClientType } from "redis";

export type RedisClient = RedisClientType;

// Fails fast if Redis is down at startup; once connected, reconnects with backoff forever.
export function createRedisClient(url: string) {
  let hasConnected = false;
  const client = createClient({
    url,
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
