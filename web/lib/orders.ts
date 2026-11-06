// Placing an order from the terminal. Reading the user's orders back lives in history.ts.
//
// The API is the authority on what is valid; the checks here only catch the mistakes a
// trader makes while typing (too many decimals, off the tick, under the minimum) before a
// round trip, with the same rules and the same wording. Amounts are compared as BigInt minor
// units, never as numbers.
//
// Every draft carries a client order id, the API's idempotency key. It stays the same while
// the draft is unchanged, so submitting again after a timeout returns the first order rather
// than placing a second one, and is replaced once an order is placed or the draft is edited.

import type { Side } from "@slipstream/protocol";
import type { OrderStatus } from "./account";
import { decimalsOf, type MarketInfo } from "./markets";
import { apiFetch } from "./session";

export type OrderType = "limit" | "market";

export type OrderDraft = {
  side: Side;
  type: OrderType;
  price: string;
  quantity: string;
};

export type FieldErrors = Partial<Record<"price" | "quantity", string>>;

export type PlacedOrder = {
  id: string;
  side: Side;
  type: OrderType;
  price: string | null;
  quantity: string;
  status: OrderStatus;
  filledQuantity: string;
  fills: { price: string; quantity: string }[];
};

const PLAIN_DECIMAL = /^\d+(\.\d+)?$/;

// "0.01000000" reads as 0.01 in a message.
const short = (amount: string) =>
  amount.includes(".") ? amount.replace(/0+$/, "").replace(/\.$/, "") : amount;

// The amount in units of 10^-decimals, or undefined if it needs more decimals than that.
function toUnits(amount: string, decimals: number): bigint | undefined {
  const [integer = "0", fraction = ""] = amount.split(".");
  const significant = fraction.replace(/0+$/, "");
  if (significant.length > decimals) {
    return undefined;
  }
  return BigInt(integer + fraction.padEnd(decimals, "0").slice(0, decimals));
}

function checkOnGrid(
  amount: string,
  step: string,
  offGrid: string,
): { units: bigint; error?: undefined } | { units?: undefined; error: string } {
  if (!PLAIN_DECIMAL.test(amount)) {
    return { error: "must be a plain decimal such as 1.5" };
  }
  const decimals = decimalsOf(step);
  const units = toUnits(amount, decimals);
  const stepUnits = toUnits(step, decimals);
  if (units === undefined || stepUnits === undefined || units % stepUnits !== 0n) {
    return { error: offGrid };
  }
  return { units };
}

export function checkOrder(market: MarketInfo, draft: OrderDraft): FieldErrors {
  const errors: FieldErrors = {};

  const quantity = checkOnGrid(
    draft.quantity.trim(),
    market.quantityStep,
    `must be a multiple of ${short(market.quantityStep)}`,
  );
  if (quantity.error !== undefined) {
    errors.quantity = quantity.error;
  } else {
    const minimum = toUnits(market.minQuantity, decimalsOf(market.quantityStep)) ?? 0n;
    if (quantity.units < minimum || quantity.units === 0n) {
      errors.quantity = `must be at least ${short(market.minQuantity)}`;
    }
  }

  if (draft.type === "limit") {
    const price = checkOnGrid(
      draft.price.trim(),
      market.tickSize,
      `must be a multiple of ${short(market.tickSize)}`,
    );
    if (price.error !== undefined) {
      errors.price = price.error;
    } else if (price.units === 0n) {
      errors.price = "must be positive";
    }
  }
  return errors;
}

export function newClientOrderId(): string {
  return crypto.randomUUID();
}

export function placeOrder(
  market: MarketInfo,
  draft: OrderDraft,
  clientOrderId: string,
): Promise<PlacedOrder> {
  const common = {
    market: market.symbol,
    side: draft.side,
    quantity: draft.quantity.trim(),
    clientOrderId,
  };
  const body =
    draft.type === "limit"
      ? { ...common, type: "limit", price: draft.price.trim() }
      : { ...common, type: "market" };
  return apiFetch<PlacedOrder>("/orders", { method: "POST", body, auth: true });
}
