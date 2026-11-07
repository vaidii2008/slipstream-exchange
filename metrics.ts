// What one API process reports to Prometheus at GET /metrics. Every metric is labelled by
// market and outcome at most, never by user or order id: each distinct label set is its own
// time series in Prometheus, so an id label would add a series per user or per order and
// grow without bound.

import { collectDefaultMetrics, Counter, Gauge, Registry } from "prom-client";
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

  // Node's own: CPU, memory, event loop lag, garbage collection. Off in tests, where nothing
  // reads them and every server would sample them again.
  collectProcessMetrics(): void {
    collectDefaultMetrics({ register: this.registry });
  }

  order(market: string, outcome: OrderOutcome): void {
    this.orders.inc({ market, outcome });
  }

  // Called for every settled command, in the market's queue, so it only adds to counters.
  settled(update: MarketUpdate): void {
    const trades = update.events.filter((event) => event.type === "trade").length;
    if (trades > 0) {
      this.trades.inc({ market: update.market.symbol }, trades);
    }
  }
}
