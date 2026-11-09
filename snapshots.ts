// Book snapshots: a market's whole engine state, written every SNAPSHOT_EVERY events, so a boot
// can start from the latest one and replay only the log after it instead of the whole log.
// The log stays the record; a snapshot is a cache of it that a boot may skip.

import { sql } from "drizzle-orm";
import type { Engine } from "./engine.ts";
import type { Database } from "./ledger.ts";
import { bookSnapshots } from "./schema.ts";

// At the deployed fleet's 50,000 or so events an hour per market, one every 12 minutes, and a
// boot replays at most this many events past the latest one.
export const SNAPSHOT_EVERY = 10_000;

// Bumped when the shape changes, so a reader can tell a snapshot it cannot read from a
// corrupt one.
const FORMAT_VERSION = 1;

// The engine's state as JSON text: its sequence and every resting order, best price first on
// each side and oldest first within a price, which is all a replay rebuilds. The order within
// a level is the time priority, so it is kept by position rather than by a timestamp. Side and
// price are the level's, not repeated per order. Amounts are decimal strings of minor units,
// like the log. Synchronous, so a caller in the market's queue gets the state exactly as of
// `engine.sequence`.
export function serializeEngine(engine: Engine): string {
  const { bids, asks } = engine.snapshot();
  const levels = (side: typeof bids) =>
    side.map((level) => ({
      price: String(level.price),
      orders: level.orders.map((order) => ({
        id: order.id,
        userId: order.userId,
        remaining: String(order.remaining),
      })),
    }));
  return JSON.stringify({
    version: FORMAT_VERSION,
    sequence: engine.sequence,
    bids: levels(bids),
    asks: levels(asks),
  });
}

// `book` is serializeEngine's text, cast to jsonb by Postgres rather than parsed and
// stringified again here.
export async function writeSnapshot(
  db: Database,
  market: string,
  sequence: number,
  book: string,
): Promise<void> {
  await db.insert(bookSnapshots).values({ market, sequence, book: sql`${book}::jsonb` });
}
