ALTER TABLE "ledger_accounts" ADD COLUMN "balance" numeric(36, 18) DEFAULT '0' NOT NULL;--> statement-breakpoint
-- Backfill: every account's cached balance starts as the sum of the entries it already has.
-- ADD COLUMN holds an exclusive lock on the table until the migration's transaction commits,
-- so no posting can land between the column appearing and its fill.
UPDATE "ledger_accounts" AS a
SET "balance" = e.total
FROM (
  SELECT "account_id", sum("amount") AS total
  FROM "ledger_entries"
  GROUP BY "account_id"
) AS e
WHERE e."account_id" = a."id";
