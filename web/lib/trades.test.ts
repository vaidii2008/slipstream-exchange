import { describe, expect, it } from "vitest";
import { mergeTrades, type Trade } from "./trades";

const trade = (sequence: number): Trade => ({
  sequence,
  price: "100.00000000",
  quantity: "1.00000000",
  takerSide: "buy",
  time: "2026-11-06T00:00:00.000Z",
});

describe("mergeTrades", () => {
  it("puts live trades above the history and keeps one copy of a trade seen both ways", () => {
    const history = [trade(5), trade(3), trade(1)];
    const live = [trade(7), trade(5)];

    expect(mergeTrades(history, live).map((t) => t.sequence)).toEqual([7, 5, 3, 1]);
  });

  it("shows at most the limit, newest first", () => {
    const history = [trade(3), trade(2), trade(1)];

    expect(mergeTrades(history, [trade(4)], 2).map((t) => t.sequence)).toEqual([4, 3]);
  });
});
