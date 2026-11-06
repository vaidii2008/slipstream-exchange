import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  numeric,
  pgEnum,
  pgTable,
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
