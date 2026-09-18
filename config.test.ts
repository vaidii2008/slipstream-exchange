import { describe, expect, it } from "vitest";
import { parseConfig } from "./config.ts";

describe("parseConfig", () => {
  it("defaults PORT to 3000 when it is not set", () => {
    expect(parseConfig({})).toEqual({ PORT: 3000 });
  });

  it("converts a numeric PORT string into a number", () => {
    expect(parseConfig({ PORT: "8080" })).toEqual({ PORT: 8080 });
  });

  it("keeps only the variables it declares", () => {
    expect(parseConfig({ PORT: "8080", AWS_SECRET_ACCESS_KEY: "leak" })).toEqual({ PORT: 8080 });
  });

  it("rejects an empty PORT instead of falling back to the default", () => {
    expect(() => parseConfig({ PORT: "" })).toThrow(/PORT/);
  });

  it.each(["abc", "0", "70000", "30.5"])("rejects PORT=%s", (port) => {
    expect(() => parseConfig({ PORT: port })).toThrow(/PORT/);
  });

  it("freezes the parsed config", () => {
    expect(Object.isFrozen(parseConfig({}))).toBe(true);
  });
});
