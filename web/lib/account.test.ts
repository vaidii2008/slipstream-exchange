import { beforeEach, describe, expect, it } from "vitest";
import {
  type BalanceSheet,
  furthest,
  isOpen,
  newerSheet,
  ORDER_UPDATES_KEPT,
  type OrderState,
  useOrderUpdates,
  withUpdates,
} from "./account";

const sheet = (version: number, available: string): BalanceSheet => ({
  version,
  balances: [{ asset: "USD", available, reserved: "0.00000000" }],
});

describe("newerSheet", () => {
  it("takes the first sheet", () => {
    expect(newerSheet(undefined, sheet(3, "10.00000000"))).toEqual(sheet(3, "10.00000000"));
  });

  it("replaces an older sheet with a newer one", () => {
    expect(newerSheet(sheet(3, "10.00000000"), sheet(7, "4.00000000"))?.version).toBe(7);
  });

  it("keeps the newer sheet when an older one arrives after it", () => {
    // Two settlements for one user: the read that saw both lands before the read that saw one.
    const kept = newerSheet(sheet(7, "4.00000000"), sheet(5, "6.00000000"));

    expect(kept).toEqual(sheet(7, "4.00000000"));
  });
});

describe("furthest", () => {
  const order = { id: "a", price: "100.00", status: "open" as const, filledQuantity: "0.0000" };

  it("takes a fill reported after the list was read", () => {
    expect(furthest(order, { status: "open", filledQuantity: "0.5000" })).toEqual({
      ...order,
      filledQuantity: "0.5000",
    });
  });

  it("never moves an order back when an older report arrives late", () => {
    const filled = { ...order, status: "filled" as const, filledQuantity: "1.0000" };

    expect(furthest(filled, { status: "open", filledQuantity: "0.5000" })).toEqual(filled);
  });

  it("keeps a partial fill when the cancel is reported without it", () => {
    const partial = { ...order, filledQuantity: "0.3000" };

    expect(furthest(partial, { status: "cancelled", filledQuantity: "0.0000" })).toEqual({
      ...partial,
      status: "cancelled",
    });
  });

  it("gives the same answer whichever report comes first", () => {
    const reports: OrderState[] = [
      { status: "open", filledQuantity: "0.2000" },
      { status: "pending", filledQuantity: "0.0000" },
      { status: "cancelled", filledQuantity: "0.6000" },
      { status: "open", filledQuantity: "0.6000" },
    ];
    const forwards = reports.reduce(furthest, order);
    const backwards = [...reports].reverse().reduce(furthest, order);

    expect(forwards).toEqual(backwards);
    expect(forwards).toMatchObject({ status: "cancelled", filledQuantity: "0.6000" });
  });
});

describe("order updates", () => {
  beforeEach(() => {
    useOrderUpdates.getState().clear();
  });

  it("counts an order the first time it is heard of, not on later reports", () => {
    const { receive } = useOrderUpdates.getState();
    const message = {
      type: "order" as const,
      market: "BTC-USD",
      id: "a",
      clientOrderId: null,
      sequence: 1,
    };
    receive({ ...message, status: "open", filledQuantity: "0.0000" });
    receive({ ...message, status: "filled", filledQuantity: "1.0000", sequence: 2 });

    const { updates, newOrders } = useOrderUpdates.getState();
    expect(newOrders).toBe(1);
    expect(updates.a).toEqual({ status: "filled", filledQuantity: "1.0000" });
  });

  it(`keeps the latest ${ORDER_UPDATES_KEPT} orders`, () => {
    const { report } = useOrderUpdates.getState();
    for (let i = 0; i <= ORDER_UPDATES_KEPT; i += 1) {
      report(`order-${i}`, { status: "open", filledQuantity: "0" });
    }

    const { updates } = useOrderUpdates.getState();
    expect(Object.keys(updates)).toHaveLength(ORDER_UPDATES_KEPT);
    expect(updates["order-0"]).toBeUndefined();
  });

  it("merges the reports on a listed order and shows which are still open", () => {
    const listed = [
      { id: "a", status: "open" as const, filledQuantity: "0" },
      { id: "b", status: "open" as const, filledQuantity: "0" },
    ];
    const merged = withUpdates(listed, { b: { status: "cancelled", filledQuantity: "0" } });

    expect(merged.filter(isOpen).map((order) => order.id)).toEqual(["a"]);
  });
});
