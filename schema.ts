import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const refreshTokens = pgTable(
  "refresh_tokens",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    familyId: uuid("family_id").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [index("refresh_tokens_family_id_idx").on(table.familyId)],
);

// Every amount column uses this: 18 digits either side of the point, never a float.
const money = (name: string) => numeric(name, { precision: 36, scale: 18 });

export const assets = pgTable(
  "assets",
  {
    code: text("code").primaryKey(),
    // Decimal places the asset is counted in: 8 means 1 unit is 100,000,000 minor units.
    scale: smallint("scale").notNull(),
  },
  (table) => [check("assets_scale_range", sql`${table.scale} between 0 and 18`)],
);

export const markets = pgTable(
  "markets",
  {
    symbol: text("symbol").primaryKey(),
    baseAsset: text("base_asset")
      .notNull()
      .references(() => assets.code),
    quoteAsset: text("quote_asset")
      .notNull()
      .references(() => assets.code),
    // A price must be a multiple of the tick, a quantity a multiple of the step. Together they
    // make every fill's notional (price × quantity) a whole number of quote minor units.
    tickSize: money("tick_size").notNull(),
    quantityStep: money("quantity_step").notNull(),
    minQuantity: money("min_quantity").notNull(),
  },
  (table) => [
    check("markets_distinct_assets", sql`${table.baseAsset} <> ${table.quoteAsset}`),
    check("markets_tick_size_positive", sql`${table.tickSize} > 0`),
    check("markets_quantity_step_positive", sql`${table.quantityStep} > 0`),
    check("markets_min_quantity_positive", sql`${table.minQuantity} > 0`),
  ],
);

export const ledgerBucket = pgEnum("ledger_bucket", ["available", "reserved"]);

export const ledgerAccounts = pgTable(
  "ledger_accounts",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    // Null for the system account that simulated deposits are drawn from. No cascade: a
    // user with ledger history cannot be deleted out from under it.
    userId: uuid("user_id").references(() => users.id),
    asset: text("asset")
      .notNull()
      .references(() => assets.code),
    bucket: ledgerBucket("bucket").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // NULLS NOT DISTINCT so the null-owner system account is also one per asset.
    unique("ledger_accounts_owner_asset_bucket")
      .on(table.userId, table.asset, table.bucket)
      .nullsNotDistinct(),
    check(
      "ledger_accounts_system_is_available",
      sql`${table.userId} is not null or ${table.bucket} = 'available'`,
    ),
  ],
);

export const ledgerTransactionKind = pgEnum("ledger_transaction_kind", [
  "deposit",
  "reserve",
  "release",
  "trade",
]);

export const ledgerTransactions = pgTable("ledger_transactions", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  kind: ledgerTransactionKind("kind").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const ledgerEntries = pgTable(
  "ledger_entries",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    transactionId: bigint("transaction_id", { mode: "number" })
      .notNull()
      .references(() => ledgerTransactions.id),
    accountId: bigint("account_id", { mode: "number" })
      .notNull()
      .references(() => ledgerAccounts.id),
    // Signed: positive credits the account, negative debits it.
    amount: money("amount").notNull(),
  },
  (table) => [
    index("ledger_entries_account_id_idx").on(table.accountId),
    index("ledger_entries_transaction_id_idx").on(table.transactionId),
    check("ledger_entries_amount_nonzero", sql`${table.amount} <> 0`),
  ],
);

export const orderSide = pgEnum("order_side", ["buy", "sell"]);
export const orderType = pgEnum("order_type", ["limit", "market"]);
// pending: funds reserved and the row written, but the engine has not seen it yet.
// open: resting on the book, possibly partly filled. filled and cancelled are final; a
// cancelled order may still have filled part of its quantity first.
export const orderStatus = pgEnum("order_status", ["pending", "open", "filled", "cancelled"]);

export const orders = pgTable(
  "orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // No cascade, like the ledger: a user's orders are the history behind their balances.
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    market: text("market")
      .notNull()
      .references(() => markets.symbol),
    side: orderSide("side").notNull(),
    type: orderType("type").notNull(),
    // Null exactly when the order is a market order.
    price: money("price"),
    quantity: money("quantity").notNull(),
    filledQuantity: money("filled_quantity").notNull().default("0"),
    status: orderStatus("status").notNull().default("pending"),
    // The client's own id for the order, and the idempotency key from Session 5.
    clientOrderId: text("client_order_id"),
    // The sequence number of the last engine event applied to this row. Null while pending.
    engineSequence: bigint("engine_sequence", { mode: "number" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("orders_user_client_order_id").on(table.userId, table.clientOrderId),
    check(
      "orders_price_matches_type",
      sql`(${table.type} = 'limit') = (${table.price} is not null)`,
    ),
    check("orders_price_positive", sql`${table.price} > 0`),
    check("orders_quantity_positive", sql`${table.quantity} > 0`),
    check(
      "orders_filled_within_quantity",
      sql`${table.filledQuantity} >= 0 and ${table.filledQuantity} <= ${table.quantity}`,
    ),
  ],
);

export const trades = pgTable(
  "trades",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    market: text("market")
      .notNull()
      .references(() => markets.symbol),
    makerOrderId: uuid("maker_order_id")
      .notNull()
      .references(() => orders.id),
    takerOrderId: uuid("taker_order_id")
      .notNull()
      .references(() => orders.id),
    // Always the maker's price.
    price: money("price").notNull(),
    quantity: money("quantity").notNull(),
    engineSequence: bigint("engine_sequence", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Not unique on (market, engine_sequence) yet: every engine numbers from 1 when the
    // process starts, so after a restart new trades reuse old numbers. The constraint comes
    // back once Session 10's recovery restores each market's sequence.
    index("trades_maker_order_id_idx").on(table.makerOrderId),
    index("trades_taker_order_id_idx").on(table.takerOrderId),
    // Candle reads take one market's trades in a time window (see loadCandles).
    index("trades_market_created_at_idx").on(table.market, table.createdAt),
    check("trades_price_positive", sql`${table.price} > 0`),
    check("trades_quantity_positive", sql`${table.quantity} > 0`),
  ],
);

export const engineCommandType = pgEnum("engine_command_type", ["submit", "cancel"]);

// The event log: every command a market's engine was given, written before the engine applies
// it. Replaying a market's commands in sequence order into an empty engine rebuilds its book,
// because the engine is deterministic. Rows are only ever appended.
export const engineEvents = pgTable(
  "engine_events",
  {
    market: text("market")
      .notNull()
      .references(() => markets.symbol),
    // The number the command's first event gets. Every command emits at least one event, so
    // no two commands in a market share one.
    sequence: bigint("sequence", { mode: "number" }).notNull(),
    commandType: engineCommandType("command_type").notNull(),
    // The command's arguments, amounts as decimal strings of minor units (see events.ts).
    payload: jsonb("payload").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // One writer per market: a second process appending to the same market collides here.
  (table) => [primaryKey({ columns: [table.market, table.sequence] })],
);
