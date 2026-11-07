// What one API process reports to Prometheus at GET /metrics. Every metric is labelled by
// market and outcome at most, never by user or order id: each distinct label set is its own
// time series in Prometheus, so an id label would add a series per user or per order and
// grow without bound.

import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from "prom-client";
import type { MarketUpdate } from "./exchange.ts";

// What became of one POST /orders. The first three are the order's status once placed; the
// rest are refusals, each with its own status code.
export type OrderOutcome =
  // Placed: resting, filled in full, or cancelled by the engine (a self-trade, or a market
  // order's unfilled remainder).
  | "open"
  | "filled"
  | "cancelled"
  // 400 or 422 from the order rules: off the grid, insufficient funds, no liquidity.
  | "rejected"
  // 400 before the order reached a market: a malformed body or an unlisted market.
  | "invalid"
  // 429 from the per-user limit.
  | "rate_limited"
  // 503: the market's queue is full, or the market is halted.
  | "busy"
  | "halted"
  // A client order id seen before: the original order is returned, nothing new is placed.
  | "repeat";

// The market label for an order refused before its market was looked up. The body's market
// is not used: it is client input, and any string would become a series.
export const NO_MARKET = "none";

// Half a millisecond to 10 s: a command's Postgres round trips at the low end, a backed-up
// queue at the high end. A saturated load run queued commands for about 8 s, past the 2.5 s
// these first stopped at, which hid how long the waits were.
const QUEUE_BUCKETS = [
  0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
];

export class Metrics {
  // One registry per server rather than prom-client's global one, so a test file can build
  // several servers without two of them registering the same metric name.
  readonly registry = new Registry();

  // Counters only go up; Prometheus turns them into rates (orders/s) with rate() and copes
  // with the reset to zero when the process restarts.
  readonly orders = new Counter({
    name: "slipstream_orders_total",
    help: "Order placements by market and outcome",
    labelNames: ["market", "outcome"] as const,
    registers: [this.registry],
  });

  readonly trades = new Counter({
    name: "slipstream_trades_total",
    help: "Trades settled, by market",
    labelNames: ["market"] as const,
    registers: [this.registry],
  });

  // A gauge goes up and down: what is true now, not a running total.
  readonly socketConnections = new Gauge({
    name: "slipstream_websocket_connections",
    help: "WebSocket connections open on this process",
    registers: [this.registry],
  });

  // A histogram counts observations into fixed buckets (at or under 1 ms, 2.5 ms, ...), so
  // Prometheus can estimate any percentile across processes and time windows without the
  // process keeping every sample. The estimate is only as fine as the buckets around it.
  readonly queueWait = new Histogram({
    name: "slipstream_queue_wait_seconds",
    help: "Time a command waited behind the commands queued ahead of it in its market",
    labelNames: ["market"] as const,
    buckets: QUEUE_BUCKETS,
    registers: [this.registry],
  });

  readonly command = new Histogram({
    name: "slipstream_command_seconds",
    help: "A command's turn in its market's queue: log append, match and settlement",
    labelNames: ["market"] as const,
    buckets: QUEUE_BUCKETS,
    registers: [this.registry],
  });

  // Microsecond buckets: the in-memory match is three orders of magnitude faster than the
  // Postgres writes around it, and would sit entirely in the first queue bucket.
  readonly match = new Histogram({
    name: "slipstream_match_seconds",
    help: "Time the engine took to apply a command in memory",
    labelNames: ["market"] as const,
    buckets: [1e-6, 2.5e-6, 5e-6, 1e-5, 2.5e-5, 5e-5, 1e-4, 2.5e-4, 1e-3, 1e-2],
    registers: [this.registry],
  });

  // Node's own: CPU, memory, event loop lag, garbage collection. Off in tests, where nothing
  // reads them and every server would sample them again.
  collectProcessMetrics(): void {
    collectDefaultMetrics({ register: this.registry });
  }

  order(market: string, outcome: OrderOutcome): void {
    this.orders.inc({ market, outcome });
  }

  // Called for every settled command, inside the market's queue, so it only records numbers.
  settled(update: MarketUpdate): void {
    const market = update.market.symbol;
    this.queueWait.observe({ market }, update.timing.waitSeconds);
    this.command.observe({ market }, update.timing.commandSeconds);
    this.match.observe({ market }, update.timing.matchSeconds);
    const trades = update.events.filter((event) => event.type === "trade").length;
    if (trades > 0) {
      this.trades.inc({ market }, trades);
    }
  }
}
