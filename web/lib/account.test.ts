import { describe, expect, it } from "vitest";
import { type BalanceSheet, newerSheet } from "./account";

const sheet = (version: number, available: string): BalanceSheet => ({
  version,
  balances: [{ asset: "USD", available, reserved: "0.00000000" }],
});

describe("newerSheet", () => {
  it("takes the first sheet", () => {
    expect(newerSheet(undefined, sheet(3, "10.00000000"))).toEqual(sheet(3, "10.00000000"));
  });

  it("replaces an older sheet with a newer one", () => {
    expect(newerSheet(sheet(3, "10.00000000"), sheet(7, "4.00000000"))?.version).toBe(7);
  });

  it("keeps the newer sheet when an older one arrives after it", () => {
    // Two settlements for one user: the read that saw both lands before the read that saw one.
    const kept = newerSheet(sheet(7, "4.00000000"), sheet(5, "6.00000000"));

    expect(kept).toEqual(sheet(7, "4.00000000"));
  });
});
