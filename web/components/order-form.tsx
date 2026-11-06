"use client";

import { useMutation } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import type { Side } from "@slipstream/protocol";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { decimalsOf, display, type MarketInfo } from "@/lib/markets";
import {
  checkOrder,
  type FieldErrors,
  newClientOrderId,
  type OrderDraft,
  type OrderType,
  type PlacedOrder,
  placeOrder,
} from "@/lib/orders";
import { ApiError, useSession } from "@/lib/session";

const API_MESSAGES: Record<string, string> = {
  insufficient_funds: "Not enough available balance for this order.",
  no_liquidity: "Nothing on the other side of the book to fill a market order.",
  rate_limited: "Too many orders. Wait a second and try again.",
  market_busy: "The market is busy. Try again shortly.",
  market_halted: "This market is halted.",
  client_order_id_reused: "This order id was already used for a different order.",
  signed_out: "Your session ended. Log in again.",
};

function describeFailure(error: unknown): { fields: FieldErrors; message?: string } {
  if (!(error instanceof ApiError)) {
    return { fields: {}, message: "Could not reach the exchange. Your order may not be placed." };
  }
  const fields: FieldErrors = {};
  for (const issue of error.issues) {
    if (issue.field === "price" || issue.field === "quantity") {
      fields[issue.field] = issue.message;
    }
  }
  if (Object.keys(fields).length > 0) {
    return { fields };
  }
  return { fields, message: API_MESSAGES[error.code] ?? error.message };
}

function summary(order: PlacedOrder, market: MarketInfo): string {
  const quantityDecimals = decimalsOf(market.quantityStep);
  const filled = display(order.filledQuantity, quantityDecimals);
  const size = display(order.quantity, quantityDecimals);
  const nothingFilled = /^[0.]+$/.test(order.filledQuantity);
  const verb = order.side === "buy" ? "Bought" : "Sold";
  const done = `${verb} ${filled} of ${size} ${market.baseAsset}`;
  if (order.status === "open") {
    const price = display(order.price ?? "0", decimalsOf(market.tickSize));
    return nothingFilled
      ? `${order.side === "buy" ? "Buy" : "Sell"} ${size} ${market.baseAsset} rests at ${price}.`
      : `${done}; the rest rests at ${price}.`;
  }
  if (order.status === "cancelled") {
    return `${done}; the rest found no liquidity and was cancelled.`;
  }
  return `${verb} ${filled} ${market.baseAsset}.`;
}

function Toggle<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="grid grid-cols-2 gap-1">
      {options.map((option) => (
        <Button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          variant={option.value === value ? "default" : "outline"}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </Button>
      ))}
    </div>
  );
}

const SIDES: { value: Side; label: string }[] = [
  { value: "buy", label: "Buy" },
  { value: "sell", label: "Sell" },
];
const TYPES: { value: OrderType; label: string }[] = [
  { value: "limit", label: "Limit" },
  { value: "market", label: "Market" },
];

export function OrderForm({ market }: { market: MarketInfo }) {
  const status = useSession((state) => state.status);
  const [draft, setDraft] = useState<OrderDraft>({
    side: "buy",
    type: "limit",
    price: "",
    quantity: "",
  });
  const [clientOrderId, setClientOrderId] = useState(newClientOrderId);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});

  const order = useMutation({
    mutationFn: (id: string) => placeOrder(market, draft, id),
    onSuccess() {
      setClientOrderId(newClientOrderId());
      setDraft((current) => ({ ...current, quantity: "" }));
    },
    onError(error) {
      setFieldErrors(describeFailure(error).fields);
    },
  });

  // An edited draft is a different order, so it gets a new idempotency key.
  function edit(change: Partial<OrderDraft>) {
    setDraft((current) => ({ ...current, ...change }));
    setClientOrderId(newClientOrderId());
    setFieldErrors({});
    order.reset();
  }

  function submit() {
    const errors = checkOrder(market, draft);
    setFieldErrors(errors);
    if (Object.keys(errors).length === 0) {
      order.mutate(clientOrderId);
    }
  }

  if (status !== "signed_in") {
    return (
      <section aria-label="Place an order" className="p-3 text-sm">
        <h2 className="mb-2 font-medium">Place an order</h2>
        <p className="text-muted-foreground">
          <Link href="/login" className="underline">
            Log in
          </Link>{" "}
          to trade.
        </p>
      </section>
    );
  }

  const failure = order.isError ? describeFailure(order.error).message : undefined;
  return (
    <section aria-label="Place an order" className="p-3 text-sm">
      <h2 className="mb-3 font-medium">Place an order</h2>
      <form action={submit} className="flex max-w-xs flex-col gap-3" noValidate>
        <Toggle
          label="Side"
          options={SIDES}
          value={draft.side}
          onChange={(side) => edit({ side })}
        />
        <Toggle
          label="Type"
          options={TYPES}
          value={draft.type}
          onChange={(type) => edit({ type })}
        />
        {draft.type === "limit" ? (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="price">Price ({market.quoteAsset})</Label>
            <Input
              id="price"
              inputMode="decimal"
              autoComplete="off"
              value={draft.price}
              onChange={(event) => edit({ price: event.target.value })}
              aria-invalid={fieldErrors.price !== undefined}
              aria-describedby="price-error"
            />
            <p id="price-error" className="text-xs text-destructive">
              {fieldErrors.price === undefined ? null : `Price ${fieldErrors.price}`}
            </p>
          </div>
        ) : null}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="quantity">Quantity ({market.baseAsset})</Label>
          <Input
            id="quantity"
            inputMode="decimal"
            autoComplete="off"
            value={draft.quantity}
            onChange={(event) => edit({ quantity: event.target.value })}
            aria-invalid={fieldErrors.quantity !== undefined}
            aria-describedby="quantity-error"
          />
          <p id="quantity-error" className="text-xs text-destructive">
            {fieldErrors.quantity === undefined ? null : `Quantity ${fieldErrors.quantity}`}
          </p>
        </div>
        <Button
          type="submit"
          disabled={order.isPending}
          className={
            draft.side === "buy"
              ? "bg-emerald-600 text-white hover:bg-emerald-700"
              : "bg-red-600 text-white hover:bg-red-700"
          }
        >
          {order.isPending
            ? "Placing…"
            : `${draft.side === "buy" ? "Buy" : "Sell"} ${market.baseAsset}`}
        </Button>
        <p role="status" className="text-xs">
          {order.isSuccess ? summary(order.data, market) : null}
          {failure === undefined ? null : <span className="text-destructive">{failure}</span>}
        </p>
      </form>
    </section>
  );
}
