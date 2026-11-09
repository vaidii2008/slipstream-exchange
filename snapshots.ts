// Book snapshots: a market's whole engine state, written every SNAPSHOT_EVERY events, so a boot
// can start from the latest one and replay only the log after it instead of the whole log.
// The log stays the record; a snapshot is a cache of it that a boot may skip.

import { and, desc, eq, lt, sql } from "drizzle-orm";
import { z } from "zod";
import type { Engine, EngineState } from "./engine.ts";
import { minorUnits } from "./events.ts";
import type { Database } from "./ledger.ts";
import { bookSnapshots } from "./schema.ts";

// At the deployed fleet's 50,000 or so events an hour per market, one every 12 minutes, and a
// boot replays at most this many events past the latest one.
export const SNAPSHOT_EVERY = 10_000;

// Snapshots kept per market. The newest is the one a boot uses; the two before it are there in
// case it does not read, and anything older would only ever save replaying 20,000 events.
export const SNAPSHOTS_KEPT = 3;

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

const level = z.strictObject({
  price: minorUnits,
  orders: z.array(
    z.strictObject({ id: z.string().min(1), userId: z.string().min(1), remaining: minorUnits }),
  ),
});
const snapshotFormat = z.strictObject({
  version: z.literal(FORMAT_VERSION),
  sequence: z.number().int().nonnegative(),
  bids: z.array(level),
  asks: z.array(level),
});

// A stored snapshot read back as engine state. Throws on anything serializeEngine would not
// have written, and on a row whose state is for a different sequence than the row says.
export function decodeSnapshot(book: unknown, sequence: number): EngineState {
  const state = snapshotFormat.parse(book);
  if (state.sequence !== sequence) {
    throw new Error(`snapshot row ${sequence} holds the state at ${state.sequence}`);
  }
  return { sequence: state.sequence, bids: state.bids, asks: state.asks };
}

// The sequences of a market's snapshots, newest first. Only the numbers, so trying them in
// turn reads one state at a time.
export async function snapshotSequences(db: Database, market: string): Promise<number[]> {
  const rows = await db
    .select({ sequence: bookSnapshots.sequence })
    .from(bookSnapshots)
    .where(eq(bookSnapshots.market, market))
    .orderBy(desc(bookSnapshots.sequence));
  return rows.map((row) => row.sequence);
}

export async function readSnapshot(
  db: Database,
  market: string,
  sequence: number,
): Promise<unknown> {
  const [row] = await db
    .select({ book: bookSnapshots.book })
    .from(bookSnapshots)
    .where(and(eq(bookSnapshots.market, market), eq(bookSnapshots.sequence, sequence)));
  if (row === undefined) {
    throw new Error(`snapshot ${market} ${sequence} is gone`);
  }
  return row.book;
}

// Deletes the market's snapshots older than its `keep` newest. Safe to run alongside another
// call or a write: it never deletes a row newer than the newest `keep` it saw.
export async function pruneSnapshots(
  db: Database,
  market: string,
  keep = SNAPSHOTS_KEPT,
): Promise<void> {
  const oldestKept = (await snapshotSequences(db, market))[keep - 1];
  if (oldestKept === undefined) {
    return;
  }
  await db
    .delete(bookSnapshots)
    .where(and(eq(bookSnapshots.market, market), lt(bookSnapshots.sequence, oldestKept)));
}
