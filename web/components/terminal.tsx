"use client";

import { useState } from "react";
import { Balances } from "@/components/balances";
import { Fills, OrderHistory } from "@/components/history";
import { OpenOrders } from "@/components/open-orders";
import { OrderBook } from "@/components/order-book";
import { OrderForm } from "@/components/order-form";
import { TradesFeed } from "@/components/trades-feed";
import { type MarketInfo, useMarkets } from "@/lib/markets";
import { useSession } from "@/lib/session";

const ACCOUNT_TABS = [
  { id: "open", label: "Open orders", Panel: OpenOrders },
  { id: "history", label: "Order history", Panel: OrderHistory },
  { id: "fills", label: "Fills", Panel: Fills },
] as const;

type AccountTab = (typeof ACCOUNT_TABS)[number]["id"];

// Only the chosen tab is mounted, so history and fills fetch and refetch only while shown.
function AccountPanel({ markets }: { markets: MarketInfo[] }) {
  const [tab, setTab] = useState<AccountTab>("open");
  const { Panel } = ACCOUNT_TABS.find((entry) => entry.id === tab) ?? ACCOUNT_TABS[0];

  return (
    <section aria-label="Your orders" className="border-t">
      <div role="tablist" aria-label="Your orders" className="flex gap-1 px-2">
        {ACCOUNT_TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            aria-selected={entry.id === tab}
            onClick={() => setTab(entry.id)}
            className="border-b-2 border-transparent px-3 py-2 text-sm aria-selected:border-foreground aria-selected:font-medium"
          >
            {entry.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" className="pb-2">
        <Panel markets={markets} />
      </div>
    </section>
  );
}

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
      {status === "signed_in" ? <AccountPanel markets={markets.data} /> : null}
    </div>
  );
}
