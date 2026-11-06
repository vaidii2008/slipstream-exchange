// The signed-in user's own state, from the account channel.
//
// The server sends the whole balance sheet on subscribe and again after every settlement
// that touches the user, each with a version: the highest ledger entry id it includes. Two
// markets can settle for the same user at once, and the API reads their balances
// independently, so the newer sheet can arrive first. The store keeps the highest version
// and drops anything older, rather than trusting arrival order.

import { create } from "zustand";
import type { ServerMessage } from "@slipstream/protocol";

type BalancesMessage = Extract<ServerMessage, { type: "balances" }>;

export type BalanceSheet = Pick<BalancesMessage, "version" | "balances">;

// Equal versions describe the same ledger, so either will do; an older one never replaces.
export function newerSheet(
  current: BalanceSheet | undefined,
  incoming: BalanceSheet,
): BalanceSheet | undefined {
  return current !== undefined && incoming.version < current.version ? current : incoming;
}

type BalanceStore = {
  // Undefined until the first sheet arrives, so "no balances yet" differs from zeros.
  sheet: BalanceSheet | undefined;
  receive: (message: BalancesMessage) => void;
  clear: () => void;
};

export const useBalances = create<BalanceStore>((set) => ({
  sheet: undefined,
  receive({ version, balances }) {
    set((state) => ({ sheet: newerSheet(state.sheet, { version, balances }) }));
  },
  // On sign out. Versions are per user, so the next user's first sheet must not be compared
  // with the last user's.
  clear() {
    set({ sheet: undefined });
  },
}));
