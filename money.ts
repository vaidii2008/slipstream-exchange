// The one place where decimal strings become bigint minor units and back. Everything inside
// the system (engine, ledger) works in bigint; strings exist only at the API and at Postgres.

// Postgres stores money as NUMERIC(36,18): 18 digits after the point, 18 before it.
export const MAX_SCALE = 18;
const MAX_INTEGER_DIGITS = 36 - MAX_SCALE;

// No sign, no exponent, no leading zeros, no bare "." at either end.
const DECIMAL = /^(0|[1-9]\d*)(?:\.(\d+))?$/;
// What Postgres returns for a NUMERIC: optional minus, always at least one integer digit.
const NUMERIC = /^(-)?(\d+)(?:\.(\d+))?$/;

export type ParseFailure = "malformed" | "negative" | "too_many_decimals" | "too_large";

export type ParseResult = { ok: true; units: bigint } | { ok: false; reason: ParseFailure };

function assertScale(scale: number): void {
  if (!Number.isInteger(scale) || scale < 0 || scale > MAX_SCALE) {
    throw new RangeError(`scale must be an integer from 0 to ${MAX_SCALE}, got ${scale}`);
  }
}

function combine(integer: string, fraction: string, scale: number): bigint {
  return BigInt(integer + fraction.padEnd(scale, "0"));
}

// For untrusted input: a request body. Rejects rather than rounds, because rounding a
// client's amount silently changes what they asked for.
export function parseAmount(value: string, scale: number): ParseResult {
  assertScale(scale);

  const match = DECIMAL.exec(value);
  if (match === null) {
    return { ok: false, reason: value.startsWith("-") ? "negative" : "malformed" };
  }

  const integer = match[1] ?? "";
  const fraction = match[2] ?? "";

  if (fraction.length > scale) {
    return { ok: false, reason: "too_many_decimals" };
  }
  if (integer.length > MAX_INTEGER_DIGITS) {
    return { ok: false, reason: "too_large" };
  }

  return { ok: true, units: combine(integer, fraction, scale) };
}

// For a value Postgres returned. NUMERIC(36,18) always pads to 18 decimals, so zeros past
// the asset's scale are expected; a non-zero digit there means the stored data is wrong.
export function fromNumeric(value: string, scale: number): bigint {
  assertScale(scale);

  const match = NUMERIC.exec(value);
  if (match === null) {
    throw new Error(`not a numeric value: ${JSON.stringify(value)}`);
  }

  const negative = match[1] === "-";
  const integer = match[2] ?? "";
  const fraction = (match[3] ?? "").replace(/0+$/, "");

  if (fraction.length > scale) {
    throw new Error(`numeric ${value} has more than ${scale} decimals`);
  }

  const units = combine(integer, fraction, scale);
  return negative ? -units : units;
}

// Always prints exactly `scale` decimals, so the same amount always gives the same string.
export function formatAmount(units: bigint, scale: number): string {
  assertScale(scale);

  const negative = units < 0n;
  const digits = (negative ? -units : units).toString().padStart(scale + 1, "0");
  const integer = digits.slice(0, digits.length - scale);
  const fraction = digits.slice(digits.length - scale);
  const sign = negative ? "-" : "";

  return scale === 0 ? `${sign}${integer}` : `${sign}${integer}.${fraction}`;
}
