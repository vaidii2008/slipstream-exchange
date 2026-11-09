CREATE TABLE "book_snapshots" (
	"market" text NOT NULL,
	"sequence" bigint NOT NULL,
	"book" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "book_snapshots_market_sequence_pk" PRIMARY KEY("market","sequence")
);
--> statement-breakpoint
ALTER TABLE "book_snapshots" ADD CONSTRAINT "book_snapshots_market_markets_symbol_fk" FOREIGN KEY ("market") REFERENCES "public"."markets"("symbol") ON DELETE no action ON UPDATE no action;