// What the bots do on each tick. Each strategy splits into a pure decision (which order to
// send, given prices and a random source), tested on its own, and a tick that reads the
// market over the API, decides and sends.

import type { Strategy } from "./bots.ts";
import type { MarketInfo, OrderRequest, Side } from "./client.ts";

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

export type MakerOptions = {
  // Where quotes centre before the market has traded. Must be on the tick grid.
  referencePrice: bigint;
  // From the centre to the best bid and the best ask, in ticks.
  halfSpreadTicks: number;
  // Quotes per side, each `levelSpacingTicks` further out than the last.
  levels: number;
  levelSpacingTicks: number;
  // Base quantity per quote, on the market's grid.
  quoteQuantity: bigint;
  // The base inventory the maker aims to hold, and how far from it is "full": at that
  // distance the skew is at its largest and the side that would add more stops quoting.
  targetInventory: bigint;
  maxInventory: bigint;
  maxSkewTicks: number;
};

export type Quote = { side: Side; price: bigint; quantity: bigint };

// A market maker rests a bid below and an ask above the price and earns the spread when the
// noise flow trades with both. Holding inventory is its risk: a maker that is long loses if
// the price falls. So it skews: the further it is from its target, the further it moves both
// quotes the way that sheds inventory. Long, it quotes lower, so its ask fills more often and
// its bid less. The skew is proportional to the distance, capped at maxSkewTicks.
export function makerQuotes(
  market: MarketInfo,
  centre: bigint,
  inventory: bigint,
  options: MakerOptions,
): Quote[] {
  const { maxInventory } = options;
  const raw = inventory - options.targetInventory;
  const distance = raw > maxInventory ? maxInventory : raw < -maxInventory ? -maxInventory : raw;
  // Truncates toward zero, so a small distance makes no skew rather than a one-tick one.
  const skewTicks = -((distance * BigInt(options.maxSkewTicks)) / maxInventory);
  const skewed = centre + skewTicks * market.tickSize;

  const quotes: Quote[] = [];
  for (let level = 0; level < options.levels; level += 1) {
    const ticks = BigInt(options.halfSpreadTicks + level * options.levelSpacingTicks);
    const bid = skewed - ticks * market.tickSize;
    const ask = skewed + ticks * market.tickSize;
    if (distance < maxInventory && bid >= market.tickSize) {
      quotes.push({ side: "buy", price: bid, quantity: options.quoteQuantity });
    }
    if (distance > -maxInventory) {
      quotes.push({ side: "sell", price: ask, quantity: options.quoteQuantity });
    }
  }
  return quotes;
}

export function marketMaker(options: MakerOptions): Strategy {
  return {
    async tick({ name, api, market, log }) {
      const [last, balances, open] = await Promise.all([
        api.lastPrice(market),
        api.balances(),
        api.openOrders(market),
      ]);
      const held = balances.get(market.baseAsset);
      const inventory = held === undefined ? 0n : held.available + held.reserved;
      const wanted = makerQuotes(market, last ?? options.referencePrice, inventory, options);

      // Only the difference is sent, so a quote already resting at the right price and size
      // keeps its place in the queue. Stale quotes go first: a new bid placed before an old
      // ask was cancelled could cross it, and self-trade prevention would cancel the bid.
      const key = (side: Side, price: bigint | null, quantity: bigint) =>
        `${side}:${price}:${quantity}`;
      const missing = new Map(wanted.map((q) => [key(q.side, q.price, q.quantity), q]));
      for (const order of open) {
        const resting = key(order.side, order.price, order.quantity - order.filled);
        if (!missing.delete(resting)) {
          await api.cancel(order.id);
        }
      }
      for (const quote of missing.values()) {
        const result = await api.place(market, { type: "limit", ...quote });
        if (!result.ok) {
          log("order_refused", { agent: name, error: result.error, side: quote.side });
        }
      }
    },
  };
}
