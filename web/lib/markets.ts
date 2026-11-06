// Listed markets, and the decimal arithmetic the terminal needs to show their amounts.
//
// Amounts arrive as decimal strings at the asset's full scale ("65000.10000000"). They are
// shown at the precision the market trades in (two decimals for a 0.01 tick) and compared or
// subtracted as integers of minor units. Never as JavaScript numbers: a float cannot hold
// every price exactly, and an exchange that shows 0.30000000000000004 is not trusted again.

import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "./session";

export type MarketInfo = {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  tickSize: string;
  quantityStep: string;
  minQuantity: string;
};

export function useMarkets() {
  return useQuery({
    queryKey: ["markets"],
    queryFn: async () => (await apiFetch<{ markets: MarketInfo[] }>("/markets")).markets,
    // Listings change only with a migration.
    staleTime: Infinity,
  });
}

// The decimals a grid step needs: "0.01000000" is 2, "1.00000000" is 0.
export function decimalsOf(step: string): number {
  const fraction = step.split(".")[1] ?? "";
  return fraction.replace(/0+$/, "").length;
}

// Cut to `decimals` places. Exact for anything on the market's grid, which every amount the
// API sends is; it never rounds.
export function display(amount: string, decimals: number): string {
  const [integer = "0", fraction = ""] = amount.split(".");
  return decimals === 0
    ? integer
    : `${integer}.${fraction.padEnd(decimals, "0").slice(0, decimals)}`;
}

function toUnits(amount: string, scale: number): bigint {
  const [integer = "0", fraction = ""] = amount.split(".");
  return BigInt(integer + fraction.padEnd(scale, "0").slice(0, scale));
}

function fromUnits(units: bigint, scale: number): string {
  const negative = units < 0n;
  const digits = (negative ? -units : units).toString().padStart(scale + 1, "0");
  const integer = digits.slice(0, digits.length - scale);
  const fraction = digits.slice(digits.length - scale);
  return `${negative ? "-" : ""}${scale === 0 ? integer : `${integer}.${fraction}`}`;
}

const scaleOf = (amount: string) => (amount.split(".")[1] ?? "").length;

export function subtract(a: string, b: string): string {
  const scale = Math.max(scaleOf(a), scaleOf(b));
  return fromUnits(toUnits(a, scale) - toUnits(b, scale), scale);
}
