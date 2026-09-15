import Fastify from "fastify";

export function buildServer() {
  const app = Fastify({
    logger: false,
  });

  app.get("/health", async () => {
    return { status: "ok" };
  });

  return app;
}

const port = Number(process.env.PORT ?? 3000);

const app = buildServer();

try {
  await app.listen({ port, host: "0.0.0.0" });
  console.log(`slipstream api listening on http://localhost:${port}`);
} catch (error) {
  console.error(error);
  process.exit(1);
}
