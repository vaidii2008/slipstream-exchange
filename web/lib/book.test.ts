import { describe, expect, it } from "vitest";
import { applyUpdate, fromSnapshot, levelKey } from "./book";

const snapshot = fromSnapshot({
  type: "book",
  market: "BTC-USD",
  sequence: 10,
  bids: [
    { price: "100.00000000", quantity: "1.00000000" },
    { price: "99.00000000", quantity: "2.00000000" },
  ],
  asks: [{ price: "101.00000000", quantity: "0.50000000" }],
});

const update = (
  firstSequence: number,
  sequence: number,
  changes: { side: "buy" | "sell"; price: string; quantity: string }[],
) => ({ type: "book_update" as const, market: "BTC-USD", firstSequence, sequence, changes });

describe("book", () => {
  it("applies a delta that follows the snapshot", () => {
    const { book, result } = applyUpdate(
      snapshot,
      update(11, 12, [{ side: "buy", price: "100.00000000", quantity: "0.25000000" }]),
    );

    expect(result).toBe("applied");
    expect(book.sequence).toBe(12);
    expect(book.quantities[levelKey("buy", "100.00000000")]).toBe("0.25000000");
  });

  it("keeps the price list itself when only a quantity changes", () => {
    const { book } = applyUpdate(
      snapshot,
      update(11, 11, [{ side: "buy", price: "99.00000000", quantity: "3.00000000" }]),
    );

    // The book component watches this array; the same array means it does not re-render.
    expect(book.bids).toBe(snapshot.bids);
    expect(book.asks).toBe(snapshot.asks);
  });

  it("inserts a new level in best-first order and removes one at zero", () => {
    const { book } = applyUpdate(
      snapshot,
      update(11, 11, [
        { side: "buy", price: "99.50000000", quantity: "1.00000000" },
        { side: "buy", price: "1000.00000000", quantity: "1.00000000" },
        { side: "sell", price: "101.00000000", quantity: "0.00000000" },
        { side: "sell", price: "100.50000000", quantity: "4.00000000" },
        { side: "sell", price: "102.00000000", quantity: "4.00000000" },
      ]),
    );

    // 1000 sorts above 99.5 as a number, though not as a string.
    expect(book.bids).toEqual(["1000.00000000", "100.00000000", "99.50000000", "99.00000000"]);
    expect(book.asks).toEqual(["100.50000000", "102.00000000"]);
    expect(book.quantities[levelKey("sell", "101.00000000")]).toBeUndefined();
  });

  it("drops a delta it has already applied", () => {
    const { book, result } = applyUpdate(
      snapshot,
      update(9, 10, [{ side: "buy", price: "100.00000000", quantity: "9.00000000" }]),
    );

    expect(result).toBe("duplicate");
    expect(book).toBe(snapshot);
  });

  it("marks the book unsynced on a gap and ignores deltas until a snapshot", () => {
    const gapped = applyUpdate(
      snapshot,
      update(12, 12, [{ side: "buy", price: "100.00000000", quantity: "9.00000000" }]),
    );
    expect(gapped.result).toBe("gap");
    expect(gapped.book).toMatchObject({ synced: false, sequence: 10, gaps: 1 });

    const next = applyUpdate(gapped.book, update(13, 13, []));
    expect(next.result).toBe("ignored");

    const resynced = fromSnapshot(
      { type: "book", market: "BTC-USD", sequence: 13, bids: [], asks: [] },
      gapped.book.gaps,
    );
    expect(resynced).toMatchObject({ synced: true, sequence: 13, gaps: 1 });
  });
});
