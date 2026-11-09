// What the bots do on each tick. Each strategy splits into a pure decision (which order to
// send, given prices and a random source), tested on its own, and a tick that reads the
// market over the API, decides and sends.

import type { Strategy } from "./bots.ts";
import type { MarketInfo, OpenOrder, OrderRequest, Side } from "./client.ts";
import { notional } from "./money.ts";

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

// What resting a quote reserves: base for an ask, its notional in quote for a bid.
function reservedFor(market: MarketInfo, side: Side, price: bigint, quantity: bigint): bigint {
  return side === "sell" ? quantity : notional(price, quantity, market.baseScale);
}

// Refusals that cancelling one more stale quote can cure: it frees funds, a resting slot and
// position room on its side.
const CURABLE = new Set(["insufficient_funds", "risk_max_open_orders", "risk_max_position"]);

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
      // keeps its place in the queue.
      const key = (side: Side, price: bigint | null, quantity: bigint) =>
        `${side}:${price}:${quantity}`;
      const missing = new Map(wanted.map((q) => [key(q.side, q.price, q.quantity), q]));
      let stale: OpenOrder[] = [];
      for (const order of open) {
        if (!missing.delete(key(order.side, order.price, order.quantity - order.filled))) {
          stale.push(order);
        }
      }

      // New quotes go in before stale ones come out, so a taker arriving mid-requote finds the
      // side quoted, old or new. Each new quote is paid for from what is available; the stale
      // ones stay reserved until cancelled. When the available balance does not cover a quote,
      // the stale quote furthest out on its side is cancelled first to free its funds, so the
      // maker never sends an order it cannot pay for and gives up its outermost quote, not its
      // whole side, to pay for it.
      const available = {
        buy: balances.get(market.quoteAsset)?.available ?? 0n,
        sell: held?.available ?? 0n,
      };
      const drop = async (order: OpenOrder) => {
        stale = stale.filter((o) => o !== order);
        // False when it filled first: then its reservation was spent, not freed.
        if ((await api.cancel(order.id)) && order.price !== null) {
          const remaining = order.quantity - order.filled;
          available[order.side] += reservedFor(market, order.side, order.price, remaining);
        }
      };
      // The stale quote on a side furthest from the price: the one a taker is least likely to
      // want, so the first to go. The maker only rests limits, so every price is set.
      const outward = (o: OpenOrder) => (o.side === "buy" ? -1n : 1n) * (o.price ?? 0n);
      const furthest = (side: Side) =>
        stale
          .filter((o) => o.side === side)
          .reduce<OpenOrder | undefined>(
            (out, o) => (out === undefined || outward(o) > outward(out) ? o : out),
            undefined,
          );
      // A new bid at or above a stale ask, or a new ask at or below a stale bid, would trade
      // with the maker's own order, and self-trade prevention would cancel the new one.
      const crossed = (quote: Quote) =>
        stale.filter(
          (o) =>
            o.side !== quote.side &&
            o.price !== null &&
            (quote.side === "buy" ? quote.price >= o.price : quote.price <= o.price),
        );

      // Quotes that cross nothing go first. A price move makes only one side's new quotes
      // cross: moving up, new bids reach the stale asks, and the new asks above are resting
      // before those stale asks are cancelled to make way.
      const queue = [...missing.values()].sort(
        (a, b) => Number(crossed(a).length > 0) - Number(crossed(b).length > 0),
      );
      for (const quote of queue) {
        for (const order of crossed(quote)) {
          await drop(order);
        }
        const cost = reservedFor(market, quote.side, quote.price, quote.quantity);
        for (let order = furthest(quote.side); available[quote.side] < cost && order;) {
          await drop(order);
          order = furthest(quote.side);
        }
        if (available[quote.side] < cost) {
          log("order_refused", { agent: name, error: "insufficient_funds", side: quote.side });
          continue;
        }
        let result = await api.place(market, { type: "limit", ...quote });
        // Both sets resting count against the risk guard's open-order and position limits, and
        // a fill since the balances were read can leave less available. One stale quote out of
        // the way, on this side if there is one, is enough to try again.
        const spare = furthest(quote.side) ?? stale[0];
        if (!result.ok && CURABLE.has(result.error) && spare !== undefined) {
          await drop(spare);
          result = await api.place(market, { type: "limit", ...quote });
        }
        if (result.ok) {
          available[quote.side] -= cost;
        } else {
          log("order_refused", { agent: name, error: result.error, side: quote.side });
        }
      }
      for (const order of stale) {
        await api.cancel(order.id);
      }
    },
  };
}
