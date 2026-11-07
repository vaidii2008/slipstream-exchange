// The event log's format: how an engine command is written to engine_events and read back.
// The exchange appends each command before applying it; recovery reads a market's commands
// back in order and replays them into a fresh engine.

import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import type { Engine, EngineEvent, NewOrder } from "./engine.ts";
import type { Database } from "./ledger.ts";
import { engineEvents } from "./schema.ts";

export type Command = { type: "submit"; order: NewOrder } | { type: "cancel"; orderId: string };

export type LoggedCommand = { sequence: number; command: Command };

export function applyCommand(engine: Engine, command: Command): EngineEvent[] {
  return command.type === "submit" ? engine.submit(command.order) : engine.cancel(command.orderId);
}

// The incoming order's worst price, which settlement needs to know what a buy reserved: a
// limit order's price or a market order's protection price. Null for a cancel.
export function takerLimitOf(command: Command): bigint | null {
  if (command.type === "cancel") {
    return null;
  }
  const { order } = command;
  if (order.type === "limit") {
    return order.price;
  }
  if (order.protectionPrice === undefined) {
    throw new Error(`market order ${order.id} reached the exchange without a protection price`);
  }
  return order.protectionPrice;
}

// JSON has no bigint, so amounts are stored as decimal strings of minor units: exact, and
// readable in psql. A string that is not a whole number fails to decode rather than round.
const minorUnits = z
  .string()
  .regex(/^\d+$/)
  .transform((value) => BigInt(value));

const orderPayload = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("limit"),
    id: z.string(),
    userId: z.string(),
    side: z.enum(["buy", "sell"]),
    price: minorUnits,
    quantity: minorUnits,
  }),
  z.strictObject({
    type: z.literal("market"),
    id: z.string(),
    userId: z.string(),
    side: z.enum(["buy", "sell"]),
    quantity: minorUnits,
    protectionPrice: minorUnits.optional(),
  }),
]);
const submitPayload = z.strictObject({ order: orderPayload });
const cancelPayload = z.strictObject({ orderId: z.string() });

function encode(command: Command): Record<string, unknown> {
  if (command.type === "cancel") {
    return { orderId: command.orderId };
  }
  const { order } = command;
  const common = { id: order.id, userId: order.userId, side: order.side };
  return {
    order:
      order.type === "limit"
        ? { type: "limit", ...common, price: String(order.price), quantity: String(order.quantity) }
        : {
            type: "market",
            ...common,
            quantity: String(order.quantity),
            ...(order.protectionPrice === undefined
              ? {}
              : { protectionPrice: String(order.protectionPrice) }),
          },
  };
}

export function decode(type: "submit" | "cancel", payload: unknown): Command {
  if (type === "cancel") {
    return { type, orderId: cancelPayload.parse(payload).orderId };
  }
  return { type, order: submitPayload.parse(payload).order };
}

// `sequence` is the number the command's first event will get. The primary key on (market,
// sequence) refuses a second command at the same number, so two processes writing one market
// cannot both succeed.
export async function appendCommand(
  db: Database,
  market: string,
  sequence: number,
  command: Command,
): Promise<void> {
  await db.insert(engineEvents).values({
    market,
    sequence,
    commandType: command.type,
    payload: encode(command),
  });
}

// Every command logged for the market, oldest first.
export async function readLog(db: Database, market: string): Promise<LoggedCommand[]> {
  const rows = await db
    .select({
      sequence: engineEvents.sequence,
      commandType: engineEvents.commandType,
      payload: engineEvents.payload,
    })
    .from(engineEvents)
    .where(eq(engineEvents.market, market))
    .orderBy(asc(engineEvents.sequence));
  return rows.map((row) => ({
    sequence: row.sequence,
    command: decode(row.commandType, row.payload),
  }));
}
