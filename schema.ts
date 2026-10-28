import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  numeric,
  pgTable,
  smallint,
  text,
  timestamp,
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
    tickSize: money("tick_size").notNull(),
    minQuantity: money("min_quantity").notNull(),
  },
  (table) => [
    check("markets_distinct_assets", sql`${table.baseAsset} <> ${table.quoteAsset}`),
    check("markets_tick_size_positive", sql`${table.tickSize} > 0`),
    check("markets_min_quantity_positive", sql`${table.minQuantity} > 0`),
  ],
);
