-- At scale 2, a fill of 0.0001 BTC at 0.01 USD is worth 0.000001 USD, which USD cannot hold.
-- At scale 8 every tick × step product in both markets is a whole number of minor units.
-- Stored NUMERIC amounts keep their values; only the decimals they may carry grow.
UPDATE "assets" SET "scale" = 8 WHERE "code" = 'USD';
--> statement-breakpoint
-- Added nullable, filled for the existing markets, then made NOT NULL: a NOT NULL column with
-- no default cannot be added to a table that already has rows.
ALTER TABLE "markets" ADD COLUMN "quantity_step" numeric(36, 18);
--> statement-breakpoint
UPDATE "markets" SET "quantity_step" = 0.0001 WHERE "symbol" = 'BTC-USD';
--> statement-breakpoint
UPDATE "markets" SET "quantity_step" = 0.001 WHERE "symbol" = 'ETH-USD';
--> statement-breakpoint
ALTER TABLE "markets" ALTER COLUMN "quantity_step" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "markets" ADD CONSTRAINT "markets_quantity_step_positive" CHECK ("markets"."quantity_step" > 0);
