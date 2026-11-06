// Running markets: one engine and one queue per market. Each placed order is matched in its
// market's engine, then settled (settlement.ts) before the next command starts. A market
// halts if a settlement fails and refuses commands past its cap.

import type { Side } from "./book.ts";
import { Engine, type EngineEvent, levelsTouched } from "./engine.ts";
import type { Database } from "./ledger.ts";
import {
  DuplicateOrderError,
  type Market,
  orderIdForClientOrderId,
  type OrderRequest,
  protectionPrice,
  recordOrder,
  worstPrice,
} from "./orders.ts";
import { settle, type Trade } from "./settlement.ts";

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

// Fail-stop. A settlement that fails has already happened in the engine: the book has
// matched, rested or removed orders, and the engine cannot undo that. Matching anything more
// against a book Postgres disagrees with would only spread the damage, so the market stops
// and stays stopped until the process restarts. Other markets keep trading.
export class MarketHaltedError extends Error {
  readonly market: string;

  constructor(market: string, options?: ErrorOptions) {
    super(`market ${market} is halted after a failed settlement`, options);
    this.name = "MarketHaltedError";
    this.market = market;
  }
}

// Backpressure: a market with this many commands admitted and not yet settled refuses more
// instead of queueing them. An unbounded queue turns a burst into memory growth and into
// latency for every order behind it; refusing early tells the client to back off now.
export class MarketBusyError extends Error {
  readonly market: string;

  constructor(market: string) {
    super(`market ${market} has too many commands waiting`);
    this.name = "MarketBusyError";
    this.market = market;
  }
}

export type HaltListener = (market: string, error: unknown) => void;

// What one settled command did, for market data. Sequences are the command's first and last
// event numbers: the next update in the market starts at `sequence + 1`, so a consumer that
// sees anything else missed one.
export type MarketUpdate = {
  market: Market;
  firstSequence: number;
  sequence: number;
  events: EngineEvent[];
  // When the settlement committed: the time a trade happened, as far as anyone outside sees.
  settledAt: Date;
  // Each price level the command changed, with the total now resting there (0: gone).
  levels: { side: Side; price: bigint; quantity: bigint }[];
};

// Called inside the market's queue, in sequence order, after the settlement has committed.
// It must not throw or wait: the next command starts when it returns.
export type UpdateListener = (update: MarketUpdate) => void;

export type ExchangeOptions = {
  // Per market: commands admitted and not yet settled, counting from before an order's
  // reservation, so a refused order has reserved nothing.
  maxPendingCommands?: number;
};

export const DEFAULT_MAX_PENDING_COMMANDS = 10_000;

type RunningMarket = {
  engine: Engine;
  queue: SerialQueue;
  halted: boolean;
  pending: number;
};

// One engine and one queue per market, created the first time the market is traded. The
// books live in this process's memory: an order still open when the process stops stays
// open and reserved in Postgres but is gone from the book, until Session 10's recovery
// replays the event log.
export class Exchange {
  readonly #db: Database;
  readonly #markets = new Map<string, RunningMarket>();
  readonly #haltListeners: HaltListener[] = [];
  readonly #updateListeners = new Set<UpdateListener>();
  readonly #maxPending: number;

  constructor(
    db: Database,
    { maxPendingCommands = DEFAULT_MAX_PENDING_COMMANDS }: ExchangeOptions = {},
  ) {
    this.#db = db;
    this.#maxPending = maxPendingCommands;
  }

  // Called once per halt with the settlement's error. The server logs it at fatal.
  onHalt(listener: HaltListener): void {
    this.#haltListeners.push(listener);
  }

  // Returns the function that stops the listener.
  onUpdate(listener: UpdateListener): () => void {
    this.#updateListeners.add(listener);
    return () => this.#updateListeners.delete(listener);
  }

  isHalted(symbol: string): boolean {
    return this.#markets.get(symbol)?.halted ?? false;
  }

  // Throws DuplicateOrderError, without touching the book or the ledger, when the request
  // repeats a client order id the user has already placed, MarketHaltedError when the market
  // is halted and MarketBusyError when it has too many commands waiting.
  async placeOrder(market: Market, request: OrderRequest): Promise<PlacedOrder> {
    const running = this.#market(market.symbol);
    // Checked first so a retry gets its original order back even if the book or the balance
    // has changed since. recordOrder catches the retry that races the original.
    if (request.clientOrderId !== undefined) {
      const existing = await orderIdForClientOrderId(
        this.#db,
        request.userId,
        request.clientOrderId,
      );
      if (existing !== undefined) {
        throw new DuplicateOrderError(existing);
      }
    }
    // Before anything is reserved, so a refused order costs the user nothing.
    if (running.halted) {
      throw new MarketHaltedError(market.symbol);
    }
    return this.#admitted(running, market.symbol, () => this.#place(running, market, request));
  }

  async #place(running: RunningMarket, market: Market, request: OrderRequest) {
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
              running.engine.bestPrice(request.side === "buy" ? "sell" : "buy"),
            ),
          };
    const { id } = await recordOrder(this.#db, market, accepted);

    const { clientOrderId: _clientOrderId, ...order } = accepted;
    const events = await this.#execute(
      running,
      market,
      (engine) => engine.submit({ ...order, id }),
      worstPrice(accepted),
    );
    return summarize(id, events);
  }

  // Takes a resting order off the book and releases what its unfilled quantity had reserved.
  // Queued behind every command already waiting, so an order still pending is matched first
  // and the cancel then finds it resting, filled or gone. Ownership is the caller's check.
  async cancelOrder(market: Market, orderId: string): Promise<"cancelled" | "not_open"> {
    const running = this.#market(market.symbol);
    if (running.halted) {
      throw new MarketHaltedError(market.symbol);
    }

    return this.#admitted(running, market.symbol, async () => {
      const events = await this.#execute(running, market, (engine) => engine.cancel(orderId), null);
      return events.some((event) => event.type === "cancelled") ? "cancelled" : "not_open";
    });
  }

  // The public view of a market's book. A market nobody has traded yet has an empty one. Read
  // outside the queue, so it may include a command whose settlement has not committed yet.
  depth(symbol: string, limit: number) {
    return this.#market(symbol).engine.depth(limit);
  }

  // Counts a command from admission until it has settled, failed or been refused. The check
  // and the increment happen before the first await, so two callers cannot both take the
  // last slot.
  async #admitted<T>(running: RunningMarket, symbol: string, work: () => Promise<T>): Promise<T> {
    if (running.pending >= this.#maxPending) {
      throw new MarketBusyError(symbol);
    }
    running.pending++;
    try {
      return await work();
    } finally {
      running.pending--;
    }
  }

  // Runs one engine command and its settlement as one task in the market's queue, halting the
  // market if the settlement fails. A command that throws inside the engine is not a reason to
  // halt: the engine checks its input before changing the book.
  #execute(
    running: RunningMarket,
    market: Market,
    command: (engine: Engine) => EngineEvent[],
    takerLimit: bigint | null,
  ): Promise<EngineEvent[]> {
    return running.queue.run(async () => {
      // Commands queued before the halt are refused too. An order among them stays pending
      // and reserved, like the one whose settlement failed, until Session 10's recovery.
      if (running.halted) {
        throw new MarketHaltedError(market.symbol);
      }
      const events = command(running.engine);
      try {
        await settle(this.#db, market, events, takerLimit);
      } catch (error) {
        running.halted = true;
        for (const listener of this.#haltListeners) {
          listener(market.symbol, error);
        }
        throw new MarketHaltedError(market.symbol, { cause: error });
      }
      this.#announce(running.engine, market, events);
      return events;
    });
  }

  // Every command emits at least one event (a cancel of a missing order emits a rejection),
  // so every sequence number reaches the listeners unless a settlement failed.
  #announce(engine: Engine, market: Market, events: EngineEvent[]): void {
    const first = events[0];
    const last = events.at(-1);
    if (first === undefined || last === undefined || this.#updateListeners.size === 0) {
      return;
    }
    const update: MarketUpdate = {
      market,
      firstSequence: first.sequence,
      sequence: last.sequence,
      events,
      settledAt: new Date(),
      levels: levelsTouched(events).map(({ side, price }) => ({
        side,
        price,
        quantity: engine.quantityAt(side, price),
      })),
    };
    for (const listener of this.#updateListeners) {
      listener(update);
    }
  }

  #market(symbol: string): RunningMarket {
    let market = this.#markets.get(symbol);
    if (market === undefined) {
      market = { engine: new Engine(symbol), queue: new SerialQueue(), halted: false, pending: 0 };
      this.#markets.set(symbol, market);
    }
    return market;
  }
}
