// Settlement: writing everything one engine command did to Postgres in one transaction. The
// ledger postings for each fill, the trade rows, each order's filled quantity and status, and
// the release of whatever a cancelled remainder had reserved.

import { eq, sql } from "drizzle-orm";
import type { EngineEvent } from "./engine.ts";
import {
  type Bucket,
  type Database,
  lockAccounts,
  openAccount,
  type Posting,
  postTransaction,
} from "./ledger.ts";
import { formatAmount, fromNumeric, notional } from "./money.ts";
import { type Market, reservationFor } from "./orders.ts";
import { orders, trades } from "./schema.ts";

export type Trade = Extract<EngineEvent, { type: "trade" }>;

// Ledger accounts are looked up once per settlement, however many fills touch them.
class Accounts {
  readonly #ids = new Map<string, Promise<number>>();
  readonly #tx: Database;

  constructor(tx: Database) {
    this.#tx = tx;
  }

  of(userId: string, asset: string, bucket: Bucket): Promise<number> {
    const key = `${userId}:${asset}:${bucket}`;
    let id = this.#ids.get(key);
    if (id === undefined) {
      id = openAccount(this.#tx, userId, asset, bucket);
      this.#ids.set(key, id);
    }
    return id;
  }
}

// A fill moves base from the seller's reserved to the buyer's available, and quote from the
// buyer's reserved to the seller's available. The buyer reserved at their own limit, which
// can be above the maker's price the fill happens at; that difference is no longer needed,
// so it goes back to the buyer's available in the same transaction.
async function fillPostings(
  accounts: Accounts,
  market: Market,
  trade: Trade,
  takerLimit: bigint | null,
): Promise<Posting[]> {
  if (takerLimit === null) {
    throw new Error(`trade ${trade.sequence} settled without the taker's limit`);
  }
  const buyer = trade.takerSide === "buy" ? trade.takerUserId : trade.makerUserId;
  const seller = trade.takerSide === "buy" ? trade.makerUserId : trade.takerUserId;
  const buyerLimit = trade.takerSide === "buy" ? takerLimit : trade.price;
  const paid = notional(trade.price, trade.quantity, market.baseScale);
  const reserved = notional(buyerLimit, trade.quantity, market.baseScale);
  const { baseAsset, quoteAsset } = market;

  const postings: Posting[] = [
    { accountId: await accounts.of(seller, baseAsset, "reserved"), amount: -trade.quantity },
    { accountId: await accounts.of(buyer, baseAsset, "available"), amount: trade.quantity },
    { accountId: await accounts.of(buyer, quoteAsset, "reserved"), amount: -reserved },
    { accountId: await accounts.of(seller, quoteAsset, "available"), amount: paid },
  ];
  if (reserved > paid) {
    postings.push({
      accountId: await accounts.of(buyer, quoteAsset, "available"),
      amount: reserved - paid,
    });
  }
  return postings;
}

// What a cancelled remainder had reserved, by the same rule as reservationFor. A market
// order's event has no price; only the incoming order can be one, and it reserved at
// `takerLimit`, its protection price.
function cancelledReservation(
  market: Market,
  event: Extract<EngineEvent, { type: "cancelled" }>,
  takerLimit: bigint | null,
) {
  const price = event.price ?? takerLimit;
  if (price === null) {
    throw new Error(`cancelled order ${event.orderId} has no price to release at`);
  }
  return reservationFor(market, event.side, price, event.quantity);
}

// An order as settlement left it, for the owner's private stream.
export type SettledOrder = {
  id: string;
  userId: string;
  clientOrderId: string | null;
  status: "pending" | "open" | "filled" | "cancelled";
  // At the market's base scale.
  filledQuantity: bigint;
  sequence: number;
};

const settledColumns = {
  id: orders.id,
  userId: orders.userId,
  clientOrderId: orders.clientOrderId,
  status: orders.status,
  filledQuantity: orders.filledQuantity,
};

async function applyFill(tx: Database, orderId: string, quantity: string, sequence: number) {
  // Every column on the right-hand side reads the row as it was before this update.
  const updated = await tx
    .update(orders)
    .set({
      filledQuantity: sql`${orders.filledQuantity} + ${quantity}`,
      status: sql`case when ${orders.filledQuantity} + ${quantity} = ${orders.quantity}
        then 'filled'::order_status else 'open'::order_status end`,
      engineSequence: sequence,
      updatedAt: sql`now()`,
    })
    .where(eq(orders.id, orderId))
    .returning(settledColumns);
  const [row] = updated;
  if (row === undefined || updated.length !== 1) {
    throw new Error(`filled order ${orderId} has no row`);
  }
  return row;
}

async function setStatus(
  tx: Database,
  orderId: string,
  status: "open" | "cancelled",
  sequence: number,
) {
  const updated = await tx
    .update(orders)
    .set({ status, engineSequence: sequence, updatedAt: sql`now()` })
    .where(eq(orders.id, orderId))
    .returning(settledColumns);
  const [row] = updated;
  if (row === undefined || updated.length !== 1) {
    throw new Error(`${status} order ${orderId} has no row`);
  }
  return row;
}

// Writes everything one engine command did, in one transaction: a trade row and a ledger
// transaction per fill, each order's filled quantity and status, and the release of whatever
// a cancelled remainder had reserved. `takerLimit` is the incoming order's worst price: its
// limit, or a market order's protection price. Null for a cancel, which has no incoming order.
// `settledAt` is each trade's recorded time: the caller reports the same time on the feed, so
// a trade read back from Postgres falls in the same minute it was streamed in.
// Returns each order the command touched as it now stands, in the order first touched.
export async function settle(
  db: Database,
  market: Market,
  events: EngineEvent[],
  takerLimit: bigint | null,
  settledAt: Date,
): Promise<SettledOrder[]> {
  return db.transaction(async (tx) => {
    const accounts = new Accounts(tx);
    const ledgerWork: { kind: "trade" | "release"; postings: Posting[] }[] = [];

    for (const event of events) {
      if (event.type === "trade") {
        ledgerWork.push({
          kind: "trade",
          postings: await fillPostings(accounts, market, event, takerLimit),
        });
      } else if (event.type === "cancelled") {
        const { asset, amount } = cancelledReservation(market, event, takerLimit);
        ledgerWork.push({
          kind: "release",
          postings: [
            { accountId: await accounts.of(event.userId, asset, "reserved"), amount: -amount },
            { accountId: await accounts.of(event.userId, asset, "available"), amount },
          ],
        });
      }
    }

    // Every account this command debits, locked once in id order before any posting. See
    // lockAccounts for why posting them one by one could deadlock across markets.
    const debited = ledgerWork.flatMap((work) =>
      work.postings.filter((posting) => posting.amount < 0n).map((posting) => posting.accountId),
    );
    await lockAccounts(tx, [...new Set(debited)]);

    for (const work of ledgerWork) {
      await postTransaction(tx, work.kind, work.postings);
    }

    const settled = new Map<string, SettledOrder>();
    const record = (row: Awaited<ReturnType<typeof applyFill>>, sequence: number) => {
      settled.set(row.id, {
        ...row,
        filledQuantity: fromNumeric(row.filledQuantity, market.baseScale),
        sequence,
      });
    };

    for (const event of events) {
      if (event.type === "trade") {
        const quantity = formatAmount(event.quantity, market.baseScale);
        await tx.insert(trades).values({
          market: market.symbol,
          makerOrderId: event.makerOrderId,
          takerOrderId: event.takerOrderId,
          price: formatAmount(event.price, market.quoteScale),
          quantity,
          engineSequence: event.sequence,
          createdAt: settledAt,
        });
        record(await applyFill(tx, event.makerOrderId, quantity, event.sequence), event.sequence);
        record(await applyFill(tx, event.takerOrderId, quantity, event.sequence), event.sequence);
      } else if (event.type === "rested") {
        record(await setStatus(tx, event.orderId, "open", event.sequence), event.sequence);
      } else if (event.type === "cancelled") {
        record(await setStatus(tx, event.orderId, "cancelled", event.sequence), event.sequence);
      }
    }
    return [...settled.values()];
  });
}
