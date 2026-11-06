// The signed-in user's own state, from the account channel: balances, and the latest known
// state of each of their orders.
//
// The server sends the whole balance sheet on subscribe and again after every settlement
// that touches the user, each with a version: the highest ledger entry id it includes. Two
// markets can settle for the same user at once, and the API reads their balances
// independently, so the newer sheet can arrive first. The store keeps the highest version
// and drops anything older, rather than trusting arrival order.
//
// Orders have the same problem between REST and the socket: a list fetched just before a
// fill can land after the fill's event. An order only ever moves forward (pending, then
// open, then filled or cancelled, with the filled quantity growing), so of two reports the
// one further along is right whatever order they arrived in, and merging them is safe.

import { create } from "zustand";
import type { ServerMessage } from "@slipstream/protocol";
import { compareAmounts } from "./markets";

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

export type OrderStatus = "pending" | "open" | "filled" | "cancelled";

export type OrderState = { status: OrderStatus; filledQuantity: string };

// Filled and cancelled are both final, and one order never reaches both.
const STAGE: Record<OrderStatus, number> = { pending: 0, open: 1, filled: 2, cancelled: 2 };

const isStatus = (status: string): status is OrderStatus => Object.hasOwn(STAGE, status);

export const isOpen = (state: OrderState) => STAGE[state.status] < 2;

// The order as it is now, given two reports about it: the further status and the larger
// filled quantity, keeping the rest of `known`.
export function furthest<T extends OrderState>(known: T, report: OrderState): T {
  return {
    ...known,
    status: STAGE[report.status] > STAGE[known.status] ? report.status : known.status,
    filledQuantity:
      compareAmounts(report.filledQuantity, known.filledQuantity) > 0
        ? report.filledQuantity
        : known.filledQuantity,
  };
}

export function withUpdates<T extends OrderState & { id: string }>(
  orders: T[],
  updates: Record<string, OrderState>,
): T[] {
  return orders.map((order) => {
    const update = updates[order.id];
    return update === undefined ? order : furthest(order, update);
  });
}

// Enough for every order a person has open at once; the oldest report goes first past it.
export const ORDER_UPDATES_KEPT = 500;

type OrderMessage = Extract<ServerMessage, { type: "order" }>;

type OrderUpdateStore = {
  updates: Record<string, OrderState>;
  // Counts orders this store had not heard of before. Most are already listed, but one just
  // placed (from this tab or anywhere else) is not, so the list refetches when this changes;
  // a spare refetch costs one request.
  newOrders: number;
  report: (id: string, state: OrderState) => void;
  receive: (message: OrderMessage) => void;
  clear: () => void;
};

export const useOrderUpdates = create<OrderUpdateStore>((set, get) => ({
  updates: {},
  newOrders: 0,
  report(id, state) {
    set(({ updates, newOrders }) => {
      const known = updates[id];
      const next = { ...updates, [id]: known === undefined ? state : furthest(known, state) };
      const ids = Object.keys(next);
      for (const old of ids.slice(0, Math.max(0, ids.length - ORDER_UPDATES_KEPT))) {
        delete next[old];
      }
      return { updates: next, newOrders: known === undefined ? newOrders + 1 : newOrders };
    });
  },
  receive({ id, status, filledQuantity }) {
    // The API sends only these four; anything else would be a newer API than this terminal.
    if (isStatus(status)) {
      get().report(id, { status, filledQuantity });
    }
  },
  clear() {
    set({ updates: {}, newOrders: 0 });
  },
}));
