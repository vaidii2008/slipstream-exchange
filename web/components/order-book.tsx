"use client";

// Render isolation: the book component reads only the sorted price lists, which are new
// arrays only when a level appears or disappears. Each row reads its own quantity from the
// store. So the common update, a size change at an existing price, re-renders one row and
// nothing else, however deep the book is.

import { memo } from "react";
import type { Side } from "@slipstream/protocol";
import { levelKey, useBooks } from "@/lib/book";
import { decimalsOf, display, subtract, type MarketInfo } from "@/lib/markets";
import { useSubscription } from "@/lib/socket";

const LEVELS_SHOWN = 12;
const NO_PRICES: string[] = [];

type RowProps = {
  symbol: string;
  side: Side;
  price: string;
  priceDecimals: number;
  quantityDecimals: number;
};

const Row = memo(function Row({ symbol, side, price, priceDecimals, quantityDecimals }: RowProps) {
  const quantity = useBooks((state) => state.books[symbol]?.quantities[levelKey(side, price)]);
  if (quantity === undefined) {
    return null;
  }
  return (
    <li className="grid grid-cols-2 px-3 py-0.5 tabular-nums">
      <span className={side === "buy" ? "text-emerald-600" : "text-red-600"}>
        {display(price, priceDecimals)}
      </span>
      {/* Keyed by quantity so the flash replays on every change to this level. */}
      <span key={quantity} className="animate-flash text-right">
        {display(quantity, quantityDecimals)}
      </span>
    </li>
  );
});

function Spread({ symbol, priceDecimals }: { symbol: string; priceDecimals: number }) {
  const bestBid = useBooks((state) => state.books[symbol]?.bids[0]);
  const bestAsk = useBooks((state) => state.books[symbol]?.asks[0]);
  const spread =
    bestBid === undefined || bestAsk === undefined
      ? "—"
      : display(subtract(bestAsk, bestBid), priceDecimals);
  return (
    <div className="border-y px-3 py-1 text-xs text-muted-foreground tabular-nums">
      Spread {spread}
    </div>
  );
}

export function OrderBook({ market }: { market: MarketInfo }) {
  const { symbol } = market;
  useSubscription("book", symbol);

  const bids = useBooks((state) => state.books[symbol]?.bids ?? NO_PRICES);
  const asks = useBooks((state) => state.books[symbol]?.asks ?? NO_PRICES);
  const synced = useBooks((state) => state.books[symbol]?.synced ?? false);

  const priceDecimals = decimalsOf(market.tickSize);
  const quantityDecimals = decimalsOf(market.quantityStep);
  const shared = { symbol, priceDecimals, quantityDecimals };
  return (
    <section aria-label="Order book" className="flex flex-col text-sm">
      <header className="flex items-center justify-between px-3 py-2">
        <h2 className="font-medium">Order book</h2>
        {synced ? null : <span className="text-xs text-amber-600">Resyncing…</span>}
      </header>
      <div className="grid grid-cols-2 px-3 pb-1 text-xs text-muted-foreground">
        <span>Price ({market.quoteAsset})</span>
        <span className="text-right">Size ({market.baseAsset})</span>
      </div>
      <div className={synced ? "" : "opacity-50"}>
        {/* Best ask at the bottom, next to the spread, as on every trading screen. */}
        <ol className="flex flex-col-reverse">
          {asks.slice(0, LEVELS_SHOWN).map((price) => (
            <Row key={price} side="sell" price={price} {...shared} />
          ))}
        </ol>
        <Spread symbol={symbol} priceDecimals={priceDecimals} />
        <ol>
          {bids.slice(0, LEVELS_SHOWN).map((price) => (
            <Row key={price} side="buy" price={price} {...shared} />
          ))}
        </ol>
      </div>
    </section>
  );
}
