CREATE TYPE "public"."engine_command_type" AS ENUM('submit', 'cancel');--> statement-breakpoint
CREATE TABLE "engine_events" (
	"market" text NOT NULL,
	"sequence" bigint NOT NULL,
	"command_type" "engine_command_type" NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "engine_events_market_sequence_pk" PRIMARY KEY("market","sequence")
);
--> statement-breakpoint
ALTER TABLE "engine_events" ADD CONSTRAINT "engine_events_market_markets_symbol_fk" FOREIGN KEY ("market") REFERENCES "public"."markets"("symbol") ON DELETE no action ON UPDATE no action;