// Running markets: one engine and one queue per market. Each placed order is matched in its
// market's engine, then settled (settlement.ts) before the next command starts. A market
// halts if a settlement fails and refuses commands past its cap.

import type { Side } from "./book.ts";
import { Engine, type EngineEvent, levelsTouched } from "./engine.ts";
import {
  appendCommand,
  applyCommand,
  type Command,
  readLog,
  replay,
  takerLimitOf,
} from "./events.ts";
import type { Database } from "./ledger.ts";
import {
  DuplicateOrderError,
  type Market,
  orderIdForClientOrderId,
  type OrderRequest,
  protectionPrice,
  recordOrder,
} from "./orders.ts";
import { type Recovered, recover } from "./recovery.ts";
import { type SettledOrder, settle, type Trade } from "./settlement.ts";

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

// Fail-stop. A command whose settlement fails has already happened in the engine and the event
// log: the book has matched, rested or removed orders, and neither can undo that. Matching anything more
// against a book Postgres disagrees with would only spread the damage, so the market stops
// and stays stopped until the process restarts. Other markets keep trading.
export class MarketHaltedError extends Error {
  readonly market: string;

  constructor(market: string, options?: ErrorOptions) {
    super(`market ${market} is halted after a failed command`, options);
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

// How long one command took, in seconds, split where the time goes: waiting behind the
// commands queued ahead of it, then its own turn in the queue (the log append, the match and
// the settlement), of which the match in memory is a part.
export type CommandTiming = {
  waitSeconds: number;
  matchSeconds: number;
  commandSeconds: number;
};

// What one settled command did, for market data, and how long it took, for metrics. Sequences are the command's first and last
// event numbers: the next update in the market starts at `sequence + 1`, so a consumer that
// sees anything else missed one.
export type MarketUpdate = {
  market: Market;
  firstSequence: number;
  sequence: number;
  events: EngineEvent[];
  // The time every trade in this command happened, as far as anyone outside sees. Taken
  // just before the settlement and stored on each trade row, so the feed and Postgres agree.
  settledAt: Date;
  // Each price level the command changed, with the total now resting there (0: gone).
  levels: { side: Side; price: bigint; quantity: bigint }[];
  // Each order the command changed, as settlement left it. Private to each order's owner.
  orders: SettledOrder[];
  timing: CommandTiming;
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
  // What recovery finished when the market opened; zero for a market that failed to open.
  recovered: Recovered;
};

export type OpenedMarket = { market: string; sequence: number; halted: boolean } & Recovered;

// One engine and one queue per market. The books live in this process's memory and are
// rebuilt from the event log when a market opens: on its first command, or at boot for every
// listed market (see open).
export class Exchange {
  readonly #db: Database;
  readonly #markets = new Map<string, RunningMarket>();
  readonly #opening = new Map<string, Promise<RunningMarket>>();
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

  // Called once per halt with the error that caused it. The server logs it at fatal.
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
    const running = await this.#open(market);
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
    const events = await this.#execute(running, market, {
      type: "submit",
      order: { ...order, id },
    });
    return summarize(id, events);
  }

  // Takes a resting order off the book and releases what its unfilled quantity had reserved.
  // Queued behind every command already waiting, so an order still pending is matched first
  // and the cancel then finds it resting, filled or gone. Ownership is the caller's check.
  async cancelOrder(market: Market, orderId: string): Promise<"cancelled" | "not_open"> {
    const running = await this.#open(market);
    if (running.halted) {
      throw new MarketHaltedError(market.symbol);
    }

    return this.#admitted(running, market.symbol, async () => {
      const events = await this.#execute(running, market, { type: "cancel", orderId });
      return events.some((event) => event.type === "cancelled") ? "cancelled" : "not_open";
    });
  }

  // The public view of a market's book. A market that has not opened yet shows an empty book
  // at sequence 0; the server opens every listed market before it listens. Read outside the
  // queue, so it may include a command whose settlement has not committed yet.
  depth(symbol: string, limit: number) {
    return (this.#markets.get(symbol)?.engine ?? new Engine(symbol)).depth(limit);
  }

  // Opens every market before the process takes traffic, so the first order in each does not
  // wait for its replay and the book served from the start is the rebuilt one.
  async open(markets: Market[]): Promise<OpenedMarket[]> {
    return Promise.all(
      markets.map(async (market) => {
        const running = await this.#open(market);
        return {
          market: market.symbol,
          sequence: running.engine.sequence,
          halted: running.halted,
          ...running.recovered,
        };
      }),
    );
  }

  // Once per market: the first caller starts the replay and every caller awaits the same one.
  // placeOrder awaits it before recording anything, so no order is reserved in a market until
  // its book is rebuilt.
  #open(market: Market): Promise<RunningMarket> {
    let opening = this.#opening.get(market.symbol);
    if (opening === undefined) {
      opening = this.#replay(market);
      this.#opening.set(market.symbol, opening);
    }
    return opening;
  }

  // Rebuilds the book from the log, then finishes what a crash interrupted (recovery.ts). A
  // log that cannot be replayed, a settlement that fails again or a book that disagrees with
  // Postgres halts the market rather than open it on a book that is not its history. Other
  // markets open as normal.
  async #replay(market: Market): Promise<RunningMarket> {
    const running: RunningMarket = {
      engine: new Engine(market.symbol),
      queue: new SerialQueue(),
      halted: false,
      pending: 0,
      recovered: { settled: 0, cancelled: 0 },
    };
    try {
      const log = await readLog(this.#db, market.symbol);
      const replayed = replay(running.engine, log);
      running.recovered = await recover(this.#db, market, running.engine, log, replayed);
    } catch (error) {
      this.#halt(running, market.symbol, error);
    }
    this.#markets.set(market.symbol, running);
    return running;
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

  // Runs one engine command as one task in the market's queue: write it to the event log,
  // apply it to the engine, settle what it did. Input the engine would refuse is refused before
  // the log, without halting, since nothing has changed yet. After the log write, any failure
  // halts the market: the log, the book and Postgres no longer agree on what has happened.
  #execute(running: RunningMarket, market: Market, command: Command): Promise<EngineEvent[]> {
    const enqueuedAt = performance.now();
    return running.queue.run(async () => {
      const startedAt = performance.now();
      // Commands queued before the halt are refused too. An order among them stays pending
      // and reserved, like the one whose settlement failed, until recovery on restart.
      if (running.halted) {
        throw new MarketHaltedError(market.symbol);
      }
      if (command.type === "submit") {
        running.engine.validate(command.order);
      }
      // Write-ahead: once the row commits, the command has happened, whatever fails next.
      // Recovery replays it and settles what it did.
      try {
        await appendCommand(this.#db, market.symbol, running.engine.sequence + 1, command);
      } catch (error) {
        throw this.#halt(running, market.symbol, error);
      }
      let events: EngineEvent[];
      let settled: SettledOrder[];
      let matchSeconds: number;
      const settledAt = new Date();
      try {
        const matchStartedAt = performance.now();
        events = applyCommand(running.engine, command);
        matchSeconds = (performance.now() - matchStartedAt) / 1000;
        settled = await settle(this.#db, market, events, takerLimitOf(command), settledAt);
      } catch (error) {
        throw this.#halt(running, market.symbol, error);
      }
      const timing = {
        waitSeconds: (startedAt - enqueuedAt) / 1000,
        matchSeconds,
        commandSeconds: (performance.now() - startedAt) / 1000,
      };
      this.#announce(running.engine, market, events, settled, settledAt, timing);
      return events;
    });
  }

  #halt(running: RunningMarket, symbol: string, error: unknown): MarketHaltedError {
    running.halted = true;
    for (const listener of this.#haltListeners) {
      listener(symbol, error);
    }
    return new MarketHaltedError(symbol, { cause: error });
  }

  // Every command emits at least one event (a cancel of a missing order emits a rejection),
  // so every sequence number reaches the listeners unless a settlement failed.
  #announce(
    engine: Engine,
    market: Market,
    events: EngineEvent[],
    orders: SettledOrder[],
    settledAt: Date,
    timing: CommandTiming,
  ): void {
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
      settledAt,
      levels: levelsTouched(events).map(({ side, price }) => ({
        side,
        price,
        quantity: engine.quantityAt(side, price),
      })),
      orders,
      timing,
    };
    for (const listener of this.#updateListeners) {
      listener(update);
    }
  }
}
