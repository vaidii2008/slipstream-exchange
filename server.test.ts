import { afterAll, describe, expect, it } from "vitest";
import { buildServer } from "./server.ts";
import { useTestServer } from "./testing.ts";

const { pool, redis, subscriber, db, tokens, exchange, app } = useTestServer();

describe("central error handling", () => {
  const leakyMessage = 'duplicate key value violates "users_email_unique": argon2id$secret';
  const failing = buildServer({
    pool,
    redis,
    subscriber,
    db,
    tokens,
    exchange,
  });
  failing.get("/explode", () => {
    throw new Error(leakyMessage);
  });

  afterAll(async () => {
    await failing.close();
  });

  it("hides an unexpected error behind a bare internal_error", async () => {
    const response = await failing.inject({ method: "GET", url: "/explode" });

    expect(response.statusCode).toBe(500);
    expect(response.json<unknown>()).toEqual({ error: "internal_error" });
    expect(response.body).not.toContain("argon2id");
  });

  it("answers an unknown route with not_found", async () => {
    const response = await app.inject({ method: "GET", url: "/no-such-route" });

    expect(response.statusCode).toBe(404);
    expect(response.json<unknown>()).toEqual({ error: "not_found" });
  });

  it("answers malformed json with invalid_request and the parser's reason", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/login",
      headers: { "content-type": "application/json" },
      payload: '{"email":',
    });

    expect(response.statusCode).toBe(400);
    const body = response.json<{ error: string; message: unknown }>();
    expect(body.error).toBe("invalid_request");
    expect(typeof body.message).toBe("string");
  });

  it("names an unsupported content type in the same shape", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/login",
      headers: { "content-type": "application/xml" },
      payload: "<login/>",
    });

    expect(response.statusCode).toBe(415);
    expect(response.json<unknown>()).toMatchObject({ error: "unsupported_media_type" });
  });
});

describe("cors", () => {
  const preflight = (origin: string) =>
    app.inject({
      method: "OPTIONS",
      url: "/session/refresh",
      headers: { origin, "access-control-request-method": "POST" },
    });

  it("lets the web origin call the API with credentials", async () => {
    const response = await preflight("http://localhost:3001");

    expect(response.statusCode).toBe(204);
    expect(response.headers["access-control-allow-origin"]).toBe("http://localhost:3001");
    expect(response.headers["access-control-allow-credentials"]).toBe("true");
    expect(response.headers["access-control-allow-methods"]).toContain("POST");
  });

  it("gives any other origin no permission to read responses", async () => {
    const response = await preflight("https://evil.example.com");

    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("marks a simple request from the web origin as readable by it", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/health",
      headers: { origin: "http://localhost:3001" },
    });

    expect(response.headers["access-control-allow-origin"]).toBe("http://localhost:3001");
    expect(response.headers.vary).toContain("Origin");
  });
});
