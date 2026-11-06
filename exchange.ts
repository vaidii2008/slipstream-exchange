// Running markets: one engine and one queue per market. Each placed order is matched in its
// market's engine, then everything the engine did is settled in the ledger and the orders
// and trades tables before the next command starts.

import { eq, sql } from "drizzle-orm";
import { Engine, type EngineEvent } from "./engine.ts";
import {
  type Bucket,
  type Database,
  lockAccounts,
  openAccount,
  type Posting,
  postTransaction,
} from "./ledger.ts";
import { formatAmount, notional } from "./money.ts";
import {
  type Market,
  type OrderRequest,
  protectionPrice,
  recordOrder,
  reservationFor,
  worstPrice,
} from "./orders.ts";
import { orders, trades } from "./schema.ts";

// Runs async tasks one at a time, in the order they were added. Each market gets one, so its
// engine command and the settlement that follows have exactly one writer: the next command
// starts only once the previous one's settlement has committed or failed. Without it, two
// settlements could commit in the opposite order to the engine events they record.
export class SerialQueue {
  #tail: Promise<void> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(task);
    // The next task waits for this one either way. A failure belongs to this task's caller,
    // who gets `result`; it must not stop the tasks queued behind it.
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

type Trade = Extract<EngineEvent, { type: "trade" }>;

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

async function applyFill(
  tx: Database,
  orderId: string,
  quantity: string,
  sequence: number,
): Promise<void> {
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
    .returning({ id: orders.id });
  if (updated.length !== 1) {
    throw new Error(`filled order ${orderId} has no row`);
  }
}

async function setStatus(
  tx: Database,
  orderId: string,
  status: "open" | "cancelled",
  sequence: number,
): Promise<void> {
  const updated = await tx
    .update(orders)
    .set({ status, engineSequence: sequence, updatedAt: sql`now()` })
    .where(eq(orders.id, orderId))
    .returning({ id: orders.id });
  if (updated.length !== 1) {
    throw new Error(`${status} order ${orderId} has no row`);
  }
}

// Writes everything one engine command did, in one transaction: a trade row and a ledger
// transaction per fill, each order's filled quantity and status, and the release of whatever
// a cancelled remainder had reserved. `takerLimit` is the incoming order's worst price: its
// limit, or a market order's protection price. Null for a cancel, which has no incoming order.
export async function settle(
  db: Database,
  market: Market,
  events: EngineEvent[],
  takerLimit: bigint | null,
): Promise<void> {
  await db.transaction(async (tx) => {
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
        });
        await applyFill(tx, event.makerOrderId, quantity, event.sequence);
        await applyFill(tx, event.takerOrderId, quantity, event.sequence);
      } else if (event.type === "rested") {
        await setStatus(tx, event.orderId, "open", event.sequence);
      } else if (event.type === "cancelled") {
        await setStatus(tx, event.orderId, "cancelled", event.sequence);
      }
    }
  });
}

export type PlacedOrder = {
  id: string;
  status: "open" | "filled" | "cancelled";
  filledQuantity: bigint;
  // The fills this order took as the taker, at the makers' prices.
  fills: { price: bigint; quantity: bigint }[];
};

function summarize(orderId: string, events: EngineEvent[]): PlacedOrder {
  const fills = events
    .filter((event): event is Trade => event.type === "trade" && event.takerOrderId === orderId)
    .map((trade) => ({ price: trade.price, quantity: trade.quantity }));
  const ended = (type: "rested" | "cancelled") =>
    events.some((event) => event.type === type && event.orderId === orderId);
  return {
    id: orderId,
    status: ended("rested") ? "open" : ended("cancelled") ? "cancelled" : "filled",
    filledQuantity: fills.reduce((total, fill) => total + fill.quantity, 0n),
    fills,
  };
}

// One engine and one queue per market, created the first time the market is traded. The
// books live in this process's memory: an order still open when the process stops stays
// open and reserved in Postgres but is gone from the book, until Session 10's recovery
// replays the event log.
export class Exchange {
  readonly #db: Database;
  readonly #markets = new Map<string, { engine: Engine; queue: SerialQueue }>();

  constructor(db: Database) {
    this.#db = db;
  }

  async placeOrder(market: Market, request: OrderRequest): Promise<PlacedOrder> {
    const { engine, queue } = this.#market(market.symbol);
    // Read from the book as it is now, outside the queue. Commands queued ahead may move the
    // book before this order runs; the protection price still bounds what it can spend.
    const accepted =
      request.type === "limit"
        ? request
        : {
            ...request,
            protectionPrice: protectionPrice(
              market,
              request.side,
              engine.bestPrice(request.side === "buy" ? "sell" : "buy"),
            ),
          };
    const { id } = await recordOrder(this.#db, market, accepted);

    return queue.run(async () => {
      const events = engine.submit({ ...accepted, id });
      await settle(this.#db, market, events, worstPrice(accepted));
      return summarize(id, events);
    });
  }

  // Takes a resting order off the book and releases what its unfilled quantity had reserved.
  // Queued behind every command already waiting, so an order still pending is matched first
  // and the cancel then finds it resting, filled or gone. Ownership is the caller's check.
  async cancelOrder(market: Market, orderId: string): Promise<"cancelled" | "not_open"> {
    const { engine, queue } = this.#market(market.symbol);

    return queue.run(async () => {
      const events = engine.cancel(orderId);
      await settle(this.#db, market, events, null);
      return events.some((event) => event.type === "cancelled") ? "cancelled" : "not_open";
    });
  }

  // The public view of a market's book. A market nobody has traded yet has an empty one.
  depth(symbol: string, limit: number) {
    return this.#market(symbol).engine.depth(limit);
  }

  #market(symbol: string): { engine: Engine; queue: SerialQueue } {
    let market = this.#markets.get(symbol);
    if (market === undefined) {
      market = { engine: new Engine(symbol), queue: new SerialQueue() };
      this.#markets.set(symbol, market);
    }
    return market;
  }
}
