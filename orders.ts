// Placing orders, in two phases. First: check the order against its market's grid, reserve
// what it could spend and record it, before the engine sees it. Second, in the market's
// queue: match it in the engine, then settle what the engine did in the ledger and the
// orders and trades tables.

import { eq, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Side } from "./book.ts";
import { Engine, type EngineEvent } from "./engine.ts";
import {
  type Bucket,
  type Database,
  LedgerError,
  lockAccounts,
  openAccount,
  type Posting,
  postTransaction,
  reserve,
} from "./ledger.ts";
import { formatAmount, fromNumeric, notional } from "./money.ts";
import { assets, markets, orders, trades } from "./schema.ts";

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

// A market with every amount already in minor units: prices and the tick at the quote
// asset's scale, quantities, the step and the minimum at the base asset's.
export type Market = {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  baseScale: number;
  quoteScale: number;
  tickSize: bigint;
  quantityStep: bigint;
  minQuantity: bigint;
};

const base = alias(assets, "base");
const quote = alias(assets, "quote");

export async function loadMarket(db: Database, symbol: string): Promise<Market | undefined> {
  const [row] = await db
    .select({
      symbol: markets.symbol,
      baseAsset: markets.baseAsset,
      quoteAsset: markets.quoteAsset,
      baseScale: base.scale,
      quoteScale: quote.scale,
      tickSize: markets.tickSize,
      quantityStep: markets.quantityStep,
      minQuantity: markets.minQuantity,
    })
    .from(markets)
    .innerJoin(base, eq(base.code, markets.baseAsset))
    .innerJoin(quote, eq(quote.code, markets.quoteAsset))
    .where(eq(markets.symbol, symbol))
    .limit(1);
  if (row === undefined) {
    return undefined;
  }
  return {
    ...row,
    tickSize: fromNumeric(row.tickSize, row.quoteScale),
    quantityStep: fromNumeric(row.quantityStep, row.baseScale),
    minQuantity: fromNumeric(row.minQuantity, row.baseScale),
  };
}

export type OrderErrorCode =
  | "price_not_positive"
  | "price_off_tick"
  | "quantity_off_step"
  | "quantity_below_minimum"
  | "insufficient_funds";

// A rejection the client caused and can fix. Anything else thrown from here is our bug.
export class OrderError extends Error {
  readonly code: OrderErrorCode;

  constructor(code: OrderErrorCode, message: string) {
    super(message);
    this.name = "OrderError";
    this.code = code;
  }
}

export type LimitOrderRequest = {
  userId: string;
  side: Side;
  // Minor units: price at the quote scale, quantity at the base scale.
  price: bigint;
  quantity: bigint;
};

export type RecordedOrder = LimitOrderRequest & { id: string; market: Market };

// The grid is what keeps every fill's notional exact, so an order off it never reaches the
// ledger or the engine.
function checkGrid(market: Market, price: bigint, quantity: bigint): void {
  if (price <= 0n) {
    throw new OrderError("price_not_positive", "price must be positive");
  }
  if (price % market.tickSize !== 0n) {
    throw new OrderError("price_off_tick", `price must be a multiple of the tick size`);
  }
  if (quantity < market.minQuantity) {
    throw new OrderError("quantity_below_minimum", "quantity is below the market minimum");
  }
  if (quantity % market.quantityStep !== 0n) {
    throw new OrderError("quantity_off_step", "quantity must be a multiple of the step");
  }
}

// The most a limit order can spend: a buy pays at most its own price for every unit, a sell
// gives up at most its quantity.
export function reservationFor(
  market: Market,
  side: Side,
  price: bigint,
  quantity: bigint,
): { asset: string; amount: bigint } {
  return side === "buy"
    ? { asset: market.quoteAsset, amount: notional(price, quantity, market.baseScale) }
    : { asset: market.baseAsset, amount: quantity };
}

// Phase one of placing an order: reserve and record in one transaction, so there is never
// a reservation without its order or an order without its reservation. The order is left
// pending for the engine.
export async function recordLimitOrder(
  db: Database,
  market: Market,
  request: LimitOrderRequest,
): Promise<RecordedOrder> {
  const { userId, side, price, quantity } = request;
  checkGrid(market, price, quantity);
  const reservation = reservationFor(market, side, price, quantity);

  return db.transaction(async (tx) => {
    try {
      await reserve(tx, userId, reservation.asset, reservation.amount);
    } catch (error) {
      if (error instanceof LedgerError && error.code === "insufficient_funds") {
        throw new OrderError(
          "insufficient_funds",
          `not enough ${reservation.asset} available for this order`,
        );
      }
      throw error;
    }

    const [row] = await tx
      .insert(orders)
      .values({
        userId,
        market: market.symbol,
        side,
        type: "limit",
        price: formatAmount(price, market.quoteScale),
        quantity: formatAmount(quantity, market.baseScale),
      })
      .returning({ id: orders.id });
    if (row === undefined) {
      throw new Error("order insert returned no row");
    }
    return { ...request, id: row.id, market };
  });
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
  takerLimit: bigint,
): Promise<Posting[]> {
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

// What a cancelled remainder had reserved, by the same rule as reservationFor.
function cancelledReservation(market: Market, event: Extract<EngineEvent, { type: "cancelled" }>) {
  if (event.price === null) {
    // Market orders reserve differently, and are not placed until Session 5's capped
    // reservation exists; reaching this means one got into the engine anyway.
    throw new Error(`cannot release order ${event.orderId}: market orders are not supported`);
  }
  return reservationFor(market, event.side, event.price, event.quantity);
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
// a cancelled remainder had reserved. `takerLimit` is the incoming order's limit price.
export async function settle(
  db: Database,
  market: Market,
  events: EngineEvent[],
  takerLimit: bigint,
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
        const { asset, amount } = cancelledReservation(market, event);
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

  async placeLimitOrder(market: Market, request: LimitOrderRequest): Promise<PlacedOrder> {
    const order = await recordLimitOrder(this.#db, market, request);
    const { engine, queue } = this.#market(market.symbol);

    return queue.run(async () => {
      const events = engine.submit({ type: "limit", ...request, id: order.id });
      await settle(this.#db, market, events, request.price);
      return summarize(order.id, events);
    });
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
