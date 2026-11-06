"use client";

import { useState } from "react";
import { Balances } from "@/components/balances";
import { OpenOrders } from "@/components/open-orders";
import { OrderBook } from "@/components/order-book";
import { OrderForm } from "@/components/order-form";
import { TradesFeed } from "@/components/trades-feed";
import { useMarkets } from "@/lib/markets";
import { useSession } from "@/lib/session";

export function Terminal() {
  const markets = useMarkets();
  const [selected, setSelected] = useState<string | undefined>();
  const status = useSession((state) => state.status);

  if (markets.isPending) {
    return <p className="p-4 text-sm text-muted-foreground">Loading markets…</p>;
  }
  if (markets.isError) {
    return <p className="p-4 text-sm text-destructive">Could not load markets from the API.</p>;
  }
  const market = markets.data.find((listed) => listed.symbol === selected) ?? markets.data[0];
  if (market === undefined) {
    return <p className="p-4 text-sm text-muted-foreground">No markets are listed.</p>;
  }

  return (
    <div className="flex flex-1 flex-col">
      <nav aria-label="Markets" className="flex gap-1 border-b px-2">
        {markets.data.map((listed) => (
          <button
            key={listed.symbol}
            type="button"
            onClick={() => setSelected(listed.symbol)}
            aria-current={listed.symbol === market.symbol ? "page" : undefined}
            className="border-b-2 border-transparent px-3 py-2 text-sm aria-[current=page]:border-foreground aria-[current=page]:font-medium"
          >
            {listed.symbol}
          </button>
        ))}
      </nav>
      <div className="grid flex-1 grid-cols-1 md:grid-cols-[minmax(16rem,22rem)_minmax(16rem,22rem)_1fr]">
        <div className="border-r">
          <OrderBook market={market} />
        </div>
        <div className="border-r">
          <TradesFeed market={market} />
        </div>
        <div>
          <Balances />
          <OrderForm market={market} />
        </div>
      </div>
      {status === "signed_in" ? (
        <section aria-label="Open orders" className="border-t">
          <header className="px-3 py-2">
            <h2 className="text-sm font-medium">Open orders</h2>
          </header>
          <OpenOrders markets={markets.data} />
        </section>
      ) : null}
    </div>
  );
}
