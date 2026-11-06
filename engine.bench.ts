// Benchmarks the matching engine on its own: no queue, no database, one market. Run with
// `npm run bench`. Every run with the same seed sends the same commands, so two runs differ
// only by the machine and the code.

import { Engine, type NewOrder } from "./engine.ts";

// mulberry32: a tiny seeded generator. Math.random cannot be seeded, and a benchmark whose
// input changes between runs cannot compare two versions of the code.
function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Command = { kind: "submit"; order: NewOrder } | { kind: "cancel"; orderId: string };
type Kind = "limit" | "market" | "cancel";

const kindOf = (command: Command): Kind =>
  command.kind === "cancel" ? "cancel" : command.order.type;

type Workload = {
  name: string;
  // Commands that build the book before anything is timed.
  setup: Command[];
  // Run untimed first, so the JIT has compiled the hot paths before we measure them.
  warmup: Command[];
  measured: Command[];
};

// Generates commands by running each one on a shadow engine, so the generator knows exactly
// which orders are resting. Cancels then hit live orders, and the workload can hold the book
// near a target size instead of letting it grow or drain over a million commands.
class Shadow {
  readonly #engine = new Engine("SHADOW");
  readonly #remaining = new Map<string, bigint>();
  // Resting ids in a flat array plus each id's position, for O(1) random pick and removal.
  readonly #ids: string[] = [];
  readonly #position = new Map<string, number>();

  get size(): number {
    return this.#ids.length;
  }

  record(command: Command): Command {
    const events =
      command.kind === "submit"
        ? this.#engine.submit(command.order)
        : this.#engine.cancel(command.orderId);
    for (const event of events) {
      if (event.type === "rested") {
        this.#remaining.set(event.orderId, event.quantity);
        this.#position.set(event.orderId, this.#ids.length);
        this.#ids.push(event.orderId);
      } else if (event.type === "trade") {
        const left = (this.#remaining.get(event.makerOrderId) ?? 0n) - event.quantity;
        if (left === 0n) {
          this.#forget(event.makerOrderId);
        } else {
          this.#remaining.set(event.makerOrderId, left);
        }
      } else if (event.type === "cancelled") {
        this.#forget(event.orderId);
      }
    }
    return command;
  }

  pick(random: () => number): string | undefined {
    return this.#ids[Math.floor(random() * this.#ids.length)];
  }

  #forget(id: string): void {
    const position = this.#position.get(id);
    if (position === undefined) {
      return;
    }
    const last = this.#ids.pop();
    if (last !== undefined && last !== id) {
      this.#ids[position] = last;
      this.#position.set(last, position);
    }
    this.#position.delete(id);
    this.#remaining.delete(id);
  }
}

// Prices in ticks around a mid of 10,000, within 50 ticks either side: a book thick near the
// spread. 1 in 10 commands is a market order and 1 in 5 limit orders is priced through the
// mid, so they take liquidity; the other limit orders rest. Cancels rise as the book grows,
// which holds it near 5,000 resting orders with cancels about as common as new orders, as on
// real venues where most orders are cancelled.
function mixedWorkload(seed: number, count: number): Workload {
  const random = generator(seed);
  const shadow = new Shadow();
  const target = 5_000;
  const mid = 10_000;
  const users = 1_000;
  let nextId = 0;
  const user = () => `u${Math.floor(random() * users)}`;
  const quantity = () => BigInt(Math.floor(random() * 100) + 1);

  const next = (): Command => {
    if (random() < 0.1) {
      const side = random() < 0.5 ? "buy" : "sell";
      const order: NewOrder = {
        type: "market",
        id: `o${++nextId}`,
        userId: user(),
        side,
        quantity: quantity(),
      };
      return { kind: "submit", order };
    }
    const orderId = shadow.pick(random);
    if (orderId !== undefined && random() < Math.min(0.9, (0.5 * shadow.size) / target)) {
      return { kind: "cancel", orderId };
    }
    const side = random() < 0.5 ? "buy" : "sell";
    const distance = Math.floor(random() * 50) + 1;
    // A buy rests below the mid and takes above it; a sell is the mirror image.
    const offset = random() < 0.2 ? -distance : distance;
    const price = BigInt(side === "buy" ? mid - offset : mid + offset);
    const order: NewOrder = {
      type: "limit",
      id: `o${++nextId}`,
      userId: user(),
      side,
      price,
      quantity: quantity(),
    };
    return { kind: "submit", order };
  };

  const build = (n: number) => Array.from({ length: n }, () => shadow.record(next()));
  return {
    name: `mixed: about ${target.toLocaleString("en-GB")} resting orders near the spread`,
    setup: build(20_000),
    warmup: build(50_000),
    measured: build(count),
  };
}

// The worst case for arrays as FIFO queues: thousands of orders at one price, filled from the
// front by market orders and cancelled from anywhere. Cancels rise as the level grows, which
// holds it near 10,000 orders.
function deepLevelWorkload(seed: number, count: number): Workload {
  const random = generator(seed);
  const shadow = new Shadow();
  const depth = 10_000;
  let nextId = 0;

  const rest = (): Command => {
    const id = `o${++nextId}`;
    const order: NewOrder = {
      type: "limit",
      id,
      userId: `maker${nextId % 100}`,
      side: "sell",
      price: 100n,
      quantity: 1n,
    };
    return { kind: "submit", order };
  };

  const next = (): Command => {
    if (random() < 0.25) {
      // Takes exactly the oldest resting order.
      const order: NewOrder = {
        type: "market",
        id: `t${++nextId}`,
        userId: "taker",
        side: "buy",
        quantity: 1n,
      };
      return { kind: "submit", order };
    }
    const orderId = shadow.pick(random);
    if (orderId !== undefined && random() < Math.min(0.9, shadow.size / depth / 3)) {
      return { kind: "cancel", orderId };
    }
    return rest();
  };

  return {
    name: `deep level: about ${depth.toLocaleString("en-GB")} orders at one price`,
    setup: Array.from({ length: depth }, () => shadow.record(rest())),
    warmup: Array.from({ length: 50_000 }, () => shadow.record(next())),
    measured: Array.from({ length: count }, () => shadow.record(next())),
  };
}

function apply(engine: Engine, command: Command): number {
  const events =
    command.kind === "submit" ? engine.submit(command.order) : engine.cancel(command.orderId);
  return events.length;
}

type Percentiles = { count: number; p50: number; p99: number; p999: number; max: number };

function percentiles(samples: number[]): Percentiles {
  const sorted = Float64Array.from(samples).sort();
  const at = (p: number) =>
    sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? Number.NaN;
  return { count: sorted.length, p50: at(50), p99: at(99), p999: at(99.9), max: at(100) };
}

type Result = {
  commandsPerSecond: number;
  all: Percentiles;
  byKind: Map<Kind, Percentiles>;
  events: number;
  bookLevels: number;
  bookOrders: number;
};

function freshEngine(workload: Workload): Engine {
  const engine = new Engine("BENCH");
  for (const command of [...workload.setup, ...workload.warmup]) {
    apply(engine, command);
  }
  return engine;
}

// Two passes over the same commands on two fresh engines. Throughput comes from a loop with
// no timer calls in it, since reading the clock costs tens of nanoseconds, a real share of a
// sub-microsecond command. Percentiles come from a second loop that times every command.
function measure(workload: Workload): Result {
  const throughputEngine = freshEngine(workload);
  let events = 0;
  const started = process.hrtime.bigint();
  for (const command of workload.measured) {
    events += apply(throughputEngine, command);
  }
  const elapsedNs = Number(process.hrtime.bigint() - started);

  const latencyEngine = freshEngine(workload);
  const all: number[] = [];
  const byKind = new Map<Kind, number[]>();
  for (const command of workload.measured) {
    const before = process.hrtime.bigint();
    apply(latencyEngine, command);
    const ns = Number(process.hrtime.bigint() - before);
    all.push(ns);
    const kind = kindOf(command);
    const samples = byKind.get(kind) ?? [];
    samples.push(ns);
    byKind.set(kind, samples);
  }

  const book = throughputEngine.snapshot();
  const levels = [...book.bids, ...book.asks];
  return {
    commandsPerSecond: workload.measured.length / (elapsedNs / 1e9),
    all: percentiles(all),
    byKind: new Map([...byKind].map(([kind, samples]) => [kind, percentiles(samples)])),
    events,
    bookLevels: levels.length,
    bookOrders: levels.reduce((total, level) => total + level.orders.length, 0),
  };
}

const COMMANDS = 1_000_000;
const SEED = 20261106;
const us = (ns: number) => `${(ns / 1000).toFixed(2)} µs`;
const line = (label: string, p: Percentiles) =>
  `  ${label.padEnd(8)} n=${p.count.toString().padStart(7)}  p50 ${us(p.p50)}  p99 ${us(p.p99)}  ` +
  `p99.9 ${us(p.p999)}  max ${us(p.max)}`;

console.log(
  `node ${process.version}, ${COMMANDS.toLocaleString("en-GB")} timed commands, seed ${SEED}\n`,
);
for (const workload of [mixedWorkload(SEED, COMMANDS), deepLevelWorkload(SEED, COMMANDS)]) {
  const result = measure(workload);
  console.log(workload.name);
  console.log(
    `  throughput ${Math.round(result.commandsPerSecond).toLocaleString("en-GB")} commands/s`,
  );
  console.log(line("all", result.all));
  for (const [kind, p] of result.byKind) {
    console.log(line(kind, p));
  }
  console.log(
    `  events ${result.events.toLocaleString("en-GB")}; book at the end: ` +
      `${result.bookLevels} levels, ${result.bookOrders.toLocaleString("en-GB")} orders\n`,
  );
}
