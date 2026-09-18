import Fastify from "fastify";
import { parseConfig } from "./config.ts";

export function buildServer() {
  const app = Fastify({
    logger: false,
  });

  app.get("/health", () => {
    return { status: "ok" };
  });

  return app;
}

try {
  const config = parseConfig(process.env);
  const app = buildServer();
  await app.listen({ port: config.PORT, host: "0.0.0.0" });
  console.log(`slipstream api listening on http://localhost:${config.PORT}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
