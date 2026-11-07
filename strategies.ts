// What the bots do on each tick. Each strategy splits into a pure decision (which order to
// send, given prices and a random source), tested on its own, and a tick that reads the
// market over the API, decides and sends.

import type { MarketInfo, OrderRequest, Side, Strategy } from "./bots.ts";

// A whole number in [0, n).
function below(random: () => number, n: number): number {
  return Math.min(n - 1, Math.floor(random() * n));
}

export type NoiseOptions = {
  // Where prices start before the market has traded. Must be on the tick grid.
  referencePrice: bigint;
  // Share of orders that are limits; the rest are market orders.
  limitShare: number;
  // How far from the last trade a limit may be, in ticks, either side.
  maxOffsetTicks: number;
  // Quantities range from the minimum up to this many quantity steps above it.
  maxExtraSteps: number;
  // Past this many resting orders the oldest is cancelled, so limits do not pile up.
  maxOpenOrders: number;
};

// A noise trader has no view on price. It buys or sells at random, sometimes at the market and
// sometimes with a limit near the last trade, which is the order flow a market maker earns its
// spread from. Its limits that land on the far side of the book cross and trade at once.
export function noiseOrder(
  market: MarketInfo,
  last: bigint,
  random: () => number,
  options: NoiseOptions,
): OrderRequest {
  const side: Side = random() < 0.5 ? "buy" : "sell";
  const quantity =
    market.minQuantity + market.quantityStep * BigInt(below(random, options.maxExtraSteps + 1));
  if (random() >= options.limitShare) {
    return { type: "market", side, quantity };
  }
  const offset = BigInt(below(random, 2 * options.maxOffsetTicks + 1) - options.maxOffsetTicks);
  const price = last + offset * market.tickSize;
  return {
    type: "limit",
    side,
    price: price < market.tickSize ? market.tickSize : price,
    quantity,
  };
}

export function noiseTrader(options: NoiseOptions): Strategy {
  return {
    async tick({ name, api, market, random, log }) {
      const open = await api.openOrders(market);
      // Listed newest first.
      const oldest = open.at(-1);
      if (open.length >= options.maxOpenOrders && oldest !== undefined) {
        await api.cancel(oldest.id);
      }
      const last = (await api.lastPrice(market)) ?? options.referencePrice;
      const order = noiseOrder(market, last, random, options);
      const result = await api.place(market, order);
      if (!result.ok) {
        // Expected now and then: a market order into an empty side, or funds all reserved.
        log("order_refused", { agent: name, error: result.error, side: order.side });
      }
    },
  };
}
