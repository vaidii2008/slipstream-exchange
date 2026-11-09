// Recovery: finishing what a crash interrupted, once a market's book has been rebuilt from its
// event log (events.ts). Placing an order is four writes in order: reserve and record it
// (pending), append its command to the log, apply it in memory, settle it. A crash between
// any two leaves one of two things behind, and recovery finishes each:
//
// - A command logged but not settled. It happened: the log is the record of what the engine
//   did. Replay has already reproduced its events; recovery settles them now.
// - An order reserved and recorded but never logged. The engine never saw it, and the client
//   was never told it was accepted, since the reply goes out only after settlement. Recovery
//   cancels it and releases its reservation; a client that retries with the same client
//   order id gets this cancelled order back, and one that sends a new order is unaffected.
//
// Then every order the database calls open must be resting on the rebuilt book with the same
// remaining quantity, and nothing else may be. A market where that fails is not opened.

import { and, eq, max } from "drizzle-orm";
import type { Engine, EngineEvent } from "./engine.ts";
import { type LoggedCommand, takerLimitOf } from "./events.ts";
import { type Database, release } from "./ledger.ts";
import { fromNumeric } from "./money.ts";
import { type Market, reservationFor } from "./orders.ts";
import { orders } from "./schema.ts";
import { settle } from "./settlement.ts";

export type Recovered = {
  // Logged commands whose settlement the crash interrupted, now settled.
  settled: number;
  // Orders reserved but never logged, now cancelled and released.
  cancelled: number;
};

// A logged command with the events replay produced for it.
export type ReplayedCommand = LoggedCommand & { events: EngineEvent[] };

// `pastFrontier` holds every logged command numbered after `frontier`, in log order, with
// its replayed events. Commands at or before the frontier have settled, so the caller can let
// them go as it replays and hold only these, which after a crash is one command or none.
export async function recover(
  db: Database,
  market: Market,
  engine: Engine,
  frontier: number,
  pastFrontier: ReplayedCommand[],
): Promise<Recovered> {
  const settled = await settleInterrupted(db, market, frontier, pastFrontier);
  const cancelled = await cancelUnlogged(db, market);
  await checkBook(db, market, engine);
  return { settled, cancelled };
}

// Settlement writes the number of every event it applies onto the orders it touches, and a
// market's commands settle one at a time in log order. So the highest number on any of the
// market's orders is the last settled event, and every command numbered after it is unsettled,
// except a rejected cancel, which writes nothing and needs nothing. At most the last command
// that writes is unsettled after a crash; after a halt, the command whose settlement failed,
// which may fail again and halt the market again. Read before the replay: nothing settles in
// the market while it opens, so it is the same number afterwards.
export async function settledFrontier(db: Database, market: Market): Promise<number> {
  const [row] = await db
    .select({ frontier: max(orders.engineSequence) })
    .from(orders)
    .where(eq(orders.market, market.symbol));
  return row?.frontier ?? 0;
}

async function settleInterrupted(
  db: Database,
  market: Market,
  frontier: number,
  pastFrontier: ReplayedCommand[],
): Promise<number> {
  let settled = 0;
  for (const { sequence, command, loggedAt, events } of pastFrontier) {
    // A rejected cancel writes nothing, so it can sit past the frontier settled or not.
    const writes = events.some((event) => event.type !== "cancel_rejected");
    if (sequence > frontier && writes) {
      // Trades are unique on (market, engine_sequence): if this rule were ever wrong and the
      // command had settled, the insert fails and the market halts rather than pay twice.
      await settle(db, market, events, takerLimitOf(command), loggedAt);
      settled++;
    }
  }
  return settled;
}

// Once every logged command is settled, every logged order has left pending, so what is still
// pending never reached the log.
async function cancelUnlogged(db: Database, market: Market): Promise<number> {
  const pending = await db
    .select({
      id: orders.id,
      userId: orders.userId,
      side: orders.side,
      price: orders.price,
      protectionPrice: orders.protectionPrice,
      quantity: orders.quantity,
    })
    .from(orders)
    .where(and(eq(orders.market, market.symbol), eq(orders.status, "pending")));

  for (const order of pending) {
    // A limit order reserved at its price, a market buy at its protection price; a sell
    // reserved its quantity whatever the price.
    const price = order.price ?? order.protectionPrice;
    if (price === null) {
      throw new Error(`pending order ${order.id} has neither a price nor a protection price`);
    }
    const { asset, amount } = reservationFor(
      market,
      order.side,
      fromNumeric(price, market.quoteScale),
      fromNumeric(order.quantity, market.baseScale),
    );
    await db.transaction(async (tx) => {
      const updated = await tx
        .update(orders)
        .set({ status: "cancelled", updatedAt: new Date() })
        .where(and(eq(orders.id, order.id), eq(orders.status, "pending")))
        .returning({ id: orders.id });
      if (updated.length !== 1) {
        throw new Error(`pending order ${order.id} changed while recovery cancelled it`);
      }
      await release(tx, order.userId, asset, amount);
    });
  }
  return pending.length;
}

async function checkBook(db: Database, market: Market, engine: Engine): Promise<void> {
  const open = await db
    .select({ id: orders.id, quantity: orders.quantity, filled: orders.filledQuantity })
    .from(orders)
    .where(and(eq(orders.market, market.symbol), eq(orders.status, "open")));
  const expected = new Map(
    open.map((order) => [
      order.id,
      fromNumeric(order.quantity, market.baseScale) - fromNumeric(order.filled, market.baseScale),
    ]),
  );

  const { bids, asks } = engine.snapshot();
  const resting = [...bids, ...asks].flatMap((level) => level.orders);
  const wrong = resting
    .filter((order) => expected.get(order.id) !== order.remaining)
    .map((order) => order.id);
  // A set, not a scan of `resting` per open order: that was open × resting comparisons, 2.8 s
  // per market at boot with 31,000 orders resting.
  const restingIds = new Set(resting.map((order) => order.id));
  const missing = [...expected.keys()].filter((id) => !restingIds.has(id));
  if (wrong.length > 0 || missing.length > 0) {
    throw new Error(
      `rebuilt ${market.symbol} book disagrees with Postgres: resting but not open there ` +
        `(or a different quantity) [${wrong.join(", ")}], open there but not resting ` +
        `[${missing.join(", ")}]`,
    );
  }
}
