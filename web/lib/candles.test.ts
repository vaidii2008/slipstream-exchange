import { describe, expect, it } from "vitest";
import { type Candle, chartBar, chartChange, mergeCandles } from "./candles";

const candle = (minute: number, trades: number, close = "100.00000000"): Candle => ({
  start: `2026-11-06T14:${String(minute).padStart(2, "0")}:00.000Z`,
  open: "100.00000000",
  high: "101.50000000",
  low: "99.00000000",
  close,
  volume: "1.00000000",
  trades,
});

describe("mergeCandles", () => {
  it("keeps one candle per minute, oldest first, and the copy with more trades", () => {
    const history = [candle(1, 4), candle(2, 2)];
    const live = [candle(3, 1), candle(2, 3, "105.00000000")];

    expect(mergeCandles(history, live)).toEqual([
      candle(1, 4),
      candle(2, 3, "105.00000000"),
      candle(3, 1),
    ]);
  });

  it("keeps the newer copy whichever way round they arrive", () => {
    // History fetched after the live candle: it already has the trade, plus one more.
    expect(mergeCandles([candle(2, 5)], [candle(2, 4)])).toEqual([candle(2, 5)]);
    // History fetched before it: the live copy is ahead.
    expect(mergeCandles([candle(2, 4)], [candle(2, 5)])).toEqual([candle(2, 5)]);
  });

  it("keeps the newest `limit` candles", () => {
    expect(mergeCandles([candle(1, 1), candle(2, 1), candle(3, 1)], [], 2)).toEqual([
      candle(2, 1),
      candle(3, 1),
    ]);
  });
});

describe("chartChange", () => {
  const a = candle(1, 1);
  const b = candle(2, 1);
  const bLater = candle(2, 2);
  const c = candle(3, 1);

  it("draws everything the first time", () => {
    expect(chartChange([], [a, b])).toEqual({ kind: "set" });
  });

  it("updates only the last bar when it gains a trade", () => {
    expect(chartChange([a, b], [a, bLater])).toEqual({ kind: "update", candle: bLater });
  });

  it("updates with a new bar for a new minute", () => {
    expect(chartChange([a, b], [a, b, c])).toEqual({ kind: "update", candle: c });
  });

  it("does nothing when nothing changed", () => {
    expect(chartChange([a, b], [a, b])).toEqual({ kind: "none" });
    expect(chartChange([], [])).toEqual({ kind: "none" });
  });

  it("redraws when an earlier bar changed, as after a refetch fills a gap", () => {
    expect(chartChange([a, c], [a, b, c])).toEqual({ kind: "set" });
    expect(chartChange([a, b], [candle(1, 2), b])).toEqual({ kind: "set" });
  });
});

describe("chartBar", () => {
  it("gives the chart seconds since the epoch and the prices as numbers", () => {
    expect(chartBar(candle(5, 1, "100.25000000"))).toEqual({
      time: Date.parse("2026-11-06T14:05:00Z") / 1000,
      open: 100,
      high: 101.5,
      low: 99,
      close: 100.25,
    });
  });
});
