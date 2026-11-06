// The order book as the terminal holds it: a snapshot, then every delta applied in sequence.
//
// Each delta names the first and last sequence of the command it describes. One at or below
// what the book already has is a duplicate and is dropped. One that does not start right
// after it means the client missed something, so the book is no longer trustworthy: it is
// marked unsynced, later deltas are ignored, and the caller subscribes again for a fresh
// snapshot.
//
// The state is shaped for rendering. `bids` and `asks` are the sorted prices, and a new array
// only when a level appears or disappears. Quantities live in a separate map keyed by side and
// price, so a row can watch its own quantity and a size change re-renders that row alone.

import { create } from "zustand";
import type { ServerMessage, Side } from "@slipstream/protocol";

type BookSnapshot = Extract<ServerMessage, { type: "book" }>;
type BookUpdate = Extract<ServerMessage, { type: "book_update" }>;

export type MarketBook = {
  sequence: number;
  // False from a detected gap or a lost connection until the next snapshot.
  synced: boolean;
  bids: string[];
  asks: string[];
  quantities: Record<string, string>;
  gaps: number;
};

export const levelKey = (side: Side, price: string) => `${side}:${price}`;

// Every price in a market has the same number of decimals, so with the point removed they
// compare as integers. Never as floats: 0.1 + 0.2 is not a price.
const units = (price: string) => BigInt(price.replace(".", ""));

const bestFirst = (side: Side) =>
  side === "buy"
    ? (a: string, b: string) => (units(b) > units(a) ? 1 : units(b) < units(a) ? -1 : 0)
    : (a: string, b: string) => (units(a) > units(b) ? 1 : units(a) < units(b) ? -1 : 0);

export function fromSnapshot(snapshot: BookSnapshot, gaps = 0): MarketBook {
  const quantities: Record<string, string> = {};
  for (const level of snapshot.bids) {
    quantities[levelKey("buy", level.price)] = level.quantity;
  }
  for (const level of snapshot.asks) {
    quantities[levelKey("sell", level.price)] = level.quantity;
  }
  return {
    sequence: snapshot.sequence,
    synced: true,
    bids: snapshot.bids.map((level) => level.price),
    asks: snapshot.asks.map((level) => level.price),
    quantities,
    gaps,
  };
}

const isZero = (quantity: string) => /^0*\.?0*$/.test(quantity);

function withLevel(prices: string[], side: Side, price: string, present: boolean): string[] {
  const has = prices.includes(price);
  if (has === present) {
    return prices;
  }
  return present
    ? [...prices, price].sort(bestFirst(side))
    : prices.filter((existing) => existing !== price);
}

export type UpdateResult = "applied" | "duplicate" | "gap" | "ignored";

export function applyUpdate(
  book: MarketBook,
  update: BookUpdate,
): { book: MarketBook; result: UpdateResult } {
  if (!book.synced) {
    return { book, result: "ignored" };
  }
  if (update.sequence <= book.sequence) {
    return { book, result: "duplicate" };
  }
  if (update.firstSequence !== book.sequence + 1) {
    return { book: { ...book, synced: false, gaps: book.gaps + 1 }, result: "gap" };
  }

  const quantities = { ...book.quantities };
  let { bids, asks } = book;
  for (const change of update.changes) {
    const key = levelKey(change.side, change.price);
    const present = !isZero(change.quantity);
    if (present) {
      quantities[key] = change.quantity;
    } else {
      delete quantities[key];
    }
    if (change.side === "buy") {
      bids = withLevel(bids, "buy", change.price, present);
    } else {
      asks = withLevel(asks, "sell", change.price, present);
    }
  }
  return {
    book: { ...book, sequence: update.sequence, bids, asks, quantities },
    result: "applied",
  };
}

type BookStore = {
  books: Record<string, MarketBook>;
  // Returns "gap" when the caller must resubscribe for a fresh snapshot.
  receive: (message: BookSnapshot | BookUpdate) => UpdateResult;
  // The connection dropped: every book may now be missing deltas.
  markAllUnsynced: () => void;
};

export const useBooks = create<BookStore>((set, get) => ({
  books: {},
  receive(message) {
    const current = get().books[message.market];
    if (message.type === "book") {
      set((state) => ({
        books: { ...state.books, [message.market]: fromSnapshot(message, current?.gaps) },
      }));
      return "applied";
    }
    if (current === undefined) {
      return "ignored";
    }
    const { book, result } = applyUpdate(current, message);
    if (book !== current) {
      set((state) => ({ books: { ...state.books, [message.market]: book } }));
    }
    return result;
  },
  markAllUnsynced() {
    set((state) => ({
      books: Object.fromEntries(
        Object.entries(state.books).map(([market, book]) => [market, { ...book, synced: false }]),
      ),
    }));
  },
}));
