import { describe, expect, it } from "vitest";
import { parseAgentConfig, parseBotConfig, parseConfig } from "./config.ts";

const base = {
  DATABASE_URL: "postgres://slipstream:slipstream@127.0.0.1:5433/slipstream",
  REDIS_URL: "redis://127.0.0.1:6380",
  JWT_ACCESS_SECRET: "test-access-secret-0123456789abcdef",
};

describe("parseConfig", () => {
  it("defaults PORT to 3000 when it is not set", () => {
    expect(parseConfig(base)).toEqual({
      ...base,
      PORT: 3000,
      ORDER_RATE_LIMIT: 20,
      LOG_LEVEL: "info",
      WEB_ORIGIN: "http://localhost:3001",
    });
  });

  it("converts a numeric PORT string into a number", () => {
    expect(parseConfig({ ...base, PORT: "8080" })).toEqual({
      ...base,
      PORT: 8080,
      ORDER_RATE_LIMIT: 20,
      LOG_LEVEL: "info",
      WEB_ORIGIN: "http://localhost:3001",
    });
  });

  it("keeps only the variables it declares", () => {
    expect(parseConfig({ ...base, AWS_SECRET_ACCESS_KEY: "leak" })).toEqual({
      ...base,
      PORT: 3000,
      ORDER_RATE_LIMIT: 20,
      LOG_LEVEL: "info",
      WEB_ORIGIN: "http://localhost:3001",
    });
  });

  it("reads ORDER_RATE_LIMIT as a whole number of orders per second", () => {
    expect(parseConfig({ ...base, ORDER_RATE_LIMIT: "50" })).toMatchObject({
      ORDER_RATE_LIMIT: 50,
    });
  });

  it.each(["0", "2.5", "many"])("rejects ORDER_RATE_LIMIT=%s", (limit) => {
    expect(() => parseConfig({ ...base, ORDER_RATE_LIMIT: limit })).toThrow(/ORDER_RATE_LIMIT/);
  });

  it("rejects an empty PORT instead of falling back to the default", () => {
    expect(() => parseConfig({ ...base, PORT: "" })).toThrow(/PORT/);
  });

  it.each(["abc", "0", "70000", "30.5"])("rejects PORT=%s", (port) => {
    expect(() => parseConfig({ ...base, PORT: port })).toThrow(/PORT/);
  });

  it("rejects a missing DATABASE_URL", () => {
    expect(() => parseConfig({ REDIS_URL: base.REDIS_URL })).toThrow(/DATABASE_URL/);
  });

  it.each(["redis://127.0.0.1:6380", "slipstream", "postgres://"])(
    "rejects DATABASE_URL=%s",
    (url) => {
      expect(() => parseConfig({ ...base, DATABASE_URL: url })).toThrow(/DATABASE_URL/);
    },
  );

  it("rejects a missing REDIS_URL", () => {
    expect(() => parseConfig({ DATABASE_URL: base.DATABASE_URL })).toThrow(/REDIS_URL/);
  });

  it.each(["postgres://127.0.0.1:5433/slipstream", "6380", "redis://"])(
    "rejects REDIS_URL=%s",
    (url) => {
      expect(() => parseConfig({ ...base, REDIS_URL: url })).toThrow(/REDIS_URL/);
    },
  );

  it("reduces WEB_ORIGIN to the origin a browser sends", () => {
    expect(parseConfig({ ...base, WEB_ORIGIN: "https://trade.example.com/" })).toMatchObject({
      WEB_ORIGIN: "https://trade.example.com",
    });
  });

  it.each(["localhost:3001", "ftp://example.com", "*"])("rejects WEB_ORIGIN=%s", (origin) => {
    expect(() => parseConfig({ ...base, WEB_ORIGIN: origin })).toThrow(/WEB_ORIGIN/);
  });

  it("accepts a pino LOG_LEVEL", () => {
    expect(parseConfig({ ...base, LOG_LEVEL: "debug" })).toMatchObject({ LOG_LEVEL: "debug" });
  });

  it("rejects a LOG_LEVEL pino does not know", () => {
    expect(() => parseConfig({ ...base, LOG_LEVEL: "verbose" })).toThrow(/LOG_LEVEL/);
  });

  it("rejects a missing JWT_ACCESS_SECRET", () => {
    expect(() =>
      parseConfig({ DATABASE_URL: base.DATABASE_URL, REDIS_URL: base.REDIS_URL }),
    ).toThrow(/JWT_ACCESS_SECRET/);
  });

  it("rejects a short JWT_ACCESS_SECRET without echoing it", () => {
    const secret = "short-secret-that-must-not-leak";
    let message = "";
    try {
      parseConfig({ ...base, JWT_ACCESS_SECRET: secret });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/JWT_ACCESS_SECRET/);
    expect(message).not.toContain(secret);
  });

  it("freezes the parsed config", () => {
    expect(Object.isFrozen(parseConfig(base))).toBe(true);
  });
});

describe("parseBotConfig", () => {
  it("defaults the API URL and keeps only the bot variables", () => {
    expect(parseBotConfig({ ...base, BOT_PASSWORD: "bot-password" })).toEqual({
      BOT_API_URL: "http://localhost:3000",
      BOT_PASSWORD: "bot-password",
    });
  });

  it("requires a password of at least 8 characters", () => {
    expect(() => parseBotConfig({})).toThrow(/BOT_PASSWORD/);
    expect(() => parseBotConfig({ BOT_PASSWORD: "short" })).toThrow(
      /must be at least 8 characters/,
    );
  });

  it("rejects an API URL that is not http(s)", () => {
    expect(() =>
      parseBotConfig({ BOT_PASSWORD: "bot-password", BOT_API_URL: "ftp://localhost" }),
    ).toThrow(/must be an http\(s\):\/\/ URL/);
  });
});

describe("parseAgentConfig", () => {
  const agent = { AGENT_EMAIL: "agent@example.com", AGENT_PASSWORD: "agent-password" };

  it("defaults the API URL and market and keeps only the agent variables", () => {
    expect(parseAgentConfig({ ...base, ...agent })).toEqual({
      AGENT_API_URL: "http://localhost:3000",
      AGENT_EMAIL: "agent@example.com",
      AGENT_PASSWORD: "agent-password",
      AGENT_MARKET: "BTC-USD",
    });
  });

  it("requires an email and a password of at least 8 characters", () => {
    expect(() => parseAgentConfig({ AGENT_PASSWORD: "agent-password" })).toThrow(/AGENT_EMAIL/);
    expect(() => parseAgentConfig({ ...agent, AGENT_EMAIL: "not-an-email" })).toThrow(
      /must be an email address/,
    );
    expect(() => parseAgentConfig({ ...agent, AGENT_PASSWORD: "short" })).toThrow(
      /must be at least 8 characters/,
    );
  });

  it("accepts only a listed market", () => {
    expect(parseAgentConfig({ ...agent, AGENT_MARKET: "ETH-USD" }).AGENT_MARKET).toBe("ETH-USD");
    expect(() => parseAgentConfig({ ...agent, AGENT_MARKET: "DOGE-USD" })).toThrow(/AGENT_MARKET/);
  });
});
