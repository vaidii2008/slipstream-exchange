"use client";

import { useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { addDemoFunds, DEMO_FUNDS, useBalances } from "@/lib/account";
import { ApiError, useSession } from "@/lib/session";
import { useSubscription } from "@/lib/socket";

export function Balances() {
  const status = useSession((state) => state.status);

  return (
    <section aria-label="Balances" className="flex flex-col border-b text-sm">
      <header className="px-3 py-2">
        <h2 className="font-medium">Balances</h2>
      </header>
      {status === "signed_in" ? (
        <>
          <BalanceTable />
          <DemoFunds />
        </>
      ) : (
        <p className="px-3 pb-3 text-xs text-muted-foreground">Log in to see your balances.</p>
      )}
    </section>
  );
}

// Its own component so the account subscription exists only while signed in.
function BalanceTable() {
  useSubscription("account");
  const sheet = useBalances((state) => state.sheet);

  if (sheet === undefined) {
    return <p className="px-3 pb-3 text-xs text-muted-foreground">Loading balances…</p>;
  }
  return (
    <table className="mb-2 w-full tabular-nums">
      <thead className="text-xs text-muted-foreground">
        <tr>
          <th className="px-3 pb-1 text-left font-normal">Asset</th>
          <th className="px-3 pb-1 text-right font-normal">Available</th>
          <th className="px-3 pb-1 text-right font-normal">In orders</th>
        </tr>
      </thead>
      <tbody>
        {/* At the asset's full scale: a fill's notional can carry more decimals than the tick. */}
        {sheet.balances.map((balance) => (
          <tr key={balance.asset}>
            <td className="px-3 py-0.5">{balance.asset}</td>
            <td className="px-3 py-0.5 text-right">{balance.available}</td>
            <td className="px-3 py-0.5 text-right text-muted-foreground">{balance.reserved}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const ADDED = DEMO_FUNDS.map(({ asset, amount }) => `${amount} ${asset}`).join(", ");

function DemoFunds() {
  const funding = useMutation({ mutationFn: addDemoFunds });
  const failure =
    funding.error instanceof ApiError ? funding.error.message : "could not reach the exchange";

  return (
    <div className="flex items-center gap-2 px-3 pb-3">
      <Button
        variant="outline"
        size="sm"
        disabled={funding.isPending}
        onClick={() => funding.mutate()}
      >
        {funding.isPending ? "Adding…" : "Add demo funds"}
      </Button>
      <p role="status" className="text-xs text-muted-foreground">
        {funding.isError ? <span className="text-destructive">{failure}</span> : null}
        {funding.isSuccess ? `Added ${ADDED}.` : null}
      </p>
    </div>
  );
}
