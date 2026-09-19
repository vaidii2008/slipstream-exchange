import { describe, expect, it } from "vitest";
import { parseConfig } from "./config.ts";

const base = {
  DATABASE_URL: "postgres://slipstream:slipstream@127.0.0.1:5433/slipstream",
  REDIS_URL: "redis://127.0.0.1:6380",
};

describe("parseConfig", () => {
  it("defaults PORT to 3000 when it is not set", () => {
    expect(parseConfig(base)).toEqual({ ...base, PORT: 3000 });
  });

  it("converts a numeric PORT string into a number", () => {
    expect(parseConfig({ ...base, PORT: "8080" })).toEqual({ ...base, PORT: 8080 });
  });

  it("keeps only the variables it declares", () => {
    expect(parseConfig({ ...base, AWS_SECRET_ACCESS_KEY: "leak" })).toEqual({
      ...base,
      PORT: 3000,
    });
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

  it("freezes the parsed config", () => {
    expect(Object.isFrozen(parseConfig(base))).toBe(true);
  });
});
