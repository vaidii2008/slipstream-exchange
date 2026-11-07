DROP INDEX "ledger_entries_account_id_idx";--> statement-breakpoint
CREATE INDEX "ledger_entries_account_id_id_idx" ON "ledger_entries" USING btree ("account_id","id");