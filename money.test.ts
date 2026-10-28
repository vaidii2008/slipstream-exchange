import { describe, expect, it } from "vitest";
import { formatAmount, fromNumeric, parseAmount } from "./money.ts";

describe("parseAmount", () => {
  it("scales a decimal string to integer minor units", () => {
    expect(parseAmount("1.5", 8)).toEqual({ ok: true, units: 150_000_000n });
    expect(parseAmount("0.00000001", 8)).toEqual({ ok: true, units: 1n });
    expect(parseAmount("42", 2)).toEqual({ ok: true, units: 4200n });
    expect(parseAmount("7", 0)).toEqual({ ok: true, units: 7n });
  });

  it("parses zero in any form to 0n and leaves positivity to the caller", () => {
    expect(parseAmount("0", 8)).toEqual({ ok: true, units: 0n });
    expect(parseAmount("0.00000000", 8)).toEqual({ ok: true, units: 0n });
  });

  it("rejects more decimals than the asset's scale instead of rounding", () => {
    expect(parseAmount("0.001", 2)).toEqual({ ok: false, reason: "too_many_decimals" });
    expect(parseAmount("1.000000001", 8)).toEqual({ ok: false, reason: "too_many_decimals" });
    expect(parseAmount("1.5", 0)).toEqual({ ok: false, reason: "too_many_decimals" });
  });

  it("rejects negative amounts by name", () => {
    expect(parseAmount("-1", 8)).toEqual({ ok: false, reason: "negative" });
    expect(parseAmount("-0.5", 8)).toEqual({ ok: false, reason: "negative" });
  });

  it.each(["", " 1", "1 ", "+1", ".5", "5.", "1e3", "1,000", "01", "0x10", "1.2.3", "NaN", "١"])(
    "rejects %j as malformed",
    (value) => {
      expect(parseAmount(value, 8)).toEqual({ ok: false, reason: "malformed" });
    },
  );

  it("accepts the largest value NUMERIC(36,18) holds and rejects one digit more", () => {
    const largest = `${"9".repeat(18)}.${"9".repeat(18)}`;
    expect(parseAmount(largest, 18)).toEqual({ ok: true, units: 10n ** 36n - 1n });
    expect(parseAmount("1" + "0".repeat(18), 18)).toEqual({ ok: false, reason: "too_large" });
  });

  it("refuses a scale the database cannot store", () => {
    expect(() => parseAmount("1", 19)).toThrow(RangeError);
    expect(() => parseAmount("1", -1)).toThrow(RangeError);
    expect(() => parseAmount("1", 1.5)).toThrow(RangeError);
  });
});

describe("formatAmount", () => {
  it("prints exactly the asset's scale in decimals", () => {
    expect(formatAmount(150_000_000n, 8)).toBe("1.50000000");
    expect(formatAmount(1n, 8)).toBe("0.00000001");
    expect(formatAmount(0n, 2)).toBe("0.00");
    expect(formatAmount(7n, 0)).toBe("7");
  });

  it("keeps the sign of a negative ledger entry", () => {
    expect(formatAmount(-1n, 8)).toBe("-0.00000001");
    expect(formatAmount(-4200n, 2)).toBe("-42.00");
  });

  it("round-trips through parseAmount for every scale", () => {
    for (let scale = 0; scale <= 18; scale += 1) {
      // 18 integer digits plus `scale` decimal digits is the largest storable at this scale.
      const largest = 10n ** BigInt(18 + scale) - 1n;
      for (const units of [0n, 1n, 9n, 10n, 123_456_789n, largest]) {
        expect(parseAmount(formatAmount(units, scale), scale)).toEqual({ ok: true, units });
      }
    }
  });
});

describe("fromNumeric", () => {
  it("reads Postgres's 18-decimal padding at a smaller asset scale", () => {
    expect(fromNumeric("1.500000000000000000", 8)).toBe(150_000_000n);
    expect(fromNumeric("0.000000000000000000", 2)).toBe(0n);
    expect(fromNumeric("100", 2)).toBe(10_000n);
  });

  it("reads negative sums from the system account", () => {
    expect(fromNumeric("-42.000000000000000000", 2)).toBe(-4200n);
  });

  it("throws when the stored value has digits beyond the asset's scale", () => {
    expect(() => fromNumeric("0.001000000000000000", 2)).toThrow(/more than 2 decimals/);
  });

  it("throws on anything that is not a numeric", () => {
    expect(() => fromNumeric("NaN", 2)).toThrow(/not a numeric/);
    expect(() => fromNumeric("", 2)).toThrow(/not a numeric/);
  });

  it("round-trips through formatAmount", () => {
    for (const units of [0n, 1n, -1n, 123_456_789n, -(10n ** 36n - 1n)]) {
      expect(fromNumeric(formatAmount(units, 18), 18)).toBe(units);
    }
  });
});
