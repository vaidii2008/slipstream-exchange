import { describe, expect, it } from "vitest";
import { compareAmounts, decimalsOf, display, subtract } from "./markets";

describe("market amounts", () => {
  it.each([
    ["0.01000000", 2],
    ["0.00010000", 4],
    ["1.00000000", 0],
    ["5", 0],
  ])("needs %s → %i decimals", (step, decimals) => {
    expect(decimalsOf(step)).toBe(decimals);
  });

  it("cuts an amount to the market's precision without rounding", () => {
    expect(display("65000.10000000", 2)).toBe("65000.10");
    expect(display("0.00010000", 4)).toBe("0.0001");
    expect(display("12.00000000", 0)).toBe("12");
    expect(display("7", 2)).toBe("7.00");
  });

  it("subtracts exactly where floats would not", () => {
    expect(subtract("0.30000000", "0.10000000")).toBe("0.20000000");
    expect(subtract("65000.01000000", "64999.99000000")).toBe("0.02000000");
    expect(subtract("1.5", "2.25")).toBe("-0.75");
  });

  it("compares amounts as integers, across scales", () => {
    expect(compareAmounts("0.30000000", "0.3")).toBe(0);
    expect(compareAmounts("0.0001", "0.00010001")).toBe(-1);
    expect(compareAmounts("10.00", "9.99999999")).toBe(1);
  });
});
