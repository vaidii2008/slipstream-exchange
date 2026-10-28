CREATE TYPE "public"."ledger_bucket" AS ENUM('available', 'reserved');--> statement-breakpoint
CREATE TYPE "public"."ledger_transaction_kind" AS ENUM('deposit', 'reserve', 'release', 'trade');--> statement-breakpoint
CREATE TABLE "ledger_accounts" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "ledger_accounts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"user_id" uuid,
	"asset" text NOT NULL,
	"bucket" "ledger_bucket" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_accounts_owner_asset_bucket" UNIQUE NULLS NOT DISTINCT("user_id","asset","bucket"),
	CONSTRAINT "ledger_accounts_system_is_available" CHECK ("ledger_accounts"."user_id" is not null or "ledger_accounts"."bucket" = 'available')
);
--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "ledger_entries_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"transaction_id" bigint NOT NULL,
	"account_id" bigint NOT NULL,
	"amount" numeric(36, 18) NOT NULL,
	CONSTRAINT "ledger_entries_amount_nonzero" CHECK ("ledger_entries"."amount" <> 0)
);
--> statement-breakpoint
CREATE TABLE "ledger_transactions" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "ledger_transactions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"kind" "ledger_transaction_kind" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_asset_assets_code_fk" FOREIGN KEY ("asset") REFERENCES "public"."assets"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_transaction_id_ledger_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."ledger_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_account_id_ledger_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."ledger_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ledger_entries_account_id_idx" ON "ledger_entries" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "ledger_entries_transaction_id_idx" ON "ledger_entries" USING btree ("transaction_id");