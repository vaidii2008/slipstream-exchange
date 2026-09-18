import { describe, expect, it } from "vitest";
import { parseConfig } from "./config.ts";

const DATABASE_URL = "postgres://slipstream:slipstream@127.0.0.1:5433/slipstream";

describe("parseConfig", () => {
  it("defaults PORT to 3000 when it is not set", () => {
    expect(parseConfig({ DATABASE_URL })).toEqual({ PORT: 3000, DATABASE_URL });
  });

  it("converts a numeric PORT string into a number", () => {
    expect(parseConfig({ DATABASE_URL, PORT: "8080" })).toEqual({ PORT: 8080, DATABASE_URL });
  });

  it("keeps only the variables it declares", () => {
    expect(parseConfig({ DATABASE_URL, AWS_SECRET_ACCESS_KEY: "leak" })).toEqual({
      PORT: 3000,
      DATABASE_URL,
    });
  });

  it("rejects an empty PORT instead of falling back to the default", () => {
    expect(() => parseConfig({ DATABASE_URL, PORT: "" })).toThrow(/PORT/);
  });

  it.each(["abc", "0", "70000", "30.5"])("rejects PORT=%s", (port) => {
    expect(() => parseConfig({ DATABASE_URL, PORT: port })).toThrow(/PORT/);
  });

  it("rejects a missing DATABASE_URL", () => {
    expect(() => parseConfig({})).toThrow(/DATABASE_URL/);
  });

  it.each(["redis://127.0.0.1:6380", "slipstream", "postgres://"])(
    "rejects DATABASE_URL=%s",
    (url) => {
      expect(() => parseConfig({ DATABASE_URL: url })).toThrow(/DATABASE_URL/);
    },
  );

  it("freezes the parsed config", () => {
    expect(Object.isFrozen(parseConfig({ DATABASE_URL }))).toBe(true);
  });
});
