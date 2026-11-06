CREATE TYPE "public"."order_side" AS ENUM('buy', 'sell');--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('pending', 'open', 'filled', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."order_type" AS ENUM('limit', 'market');--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"market" text NOT NULL,
	"side" "order_side" NOT NULL,
	"type" "order_type" NOT NULL,
	"price" numeric(36, 18),
	"quantity" numeric(36, 18) NOT NULL,
	"filled_quantity" numeric(36, 18) DEFAULT '0' NOT NULL,
	"status" "order_status" DEFAULT 'pending' NOT NULL,
	"client_order_id" text,
	"engine_sequence" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orders_user_client_order_id" UNIQUE("user_id","client_order_id"),
	CONSTRAINT "orders_price_matches_type" CHECK (("orders"."type" = 'limit') = ("orders"."price" is not null)),
	CONSTRAINT "orders_price_positive" CHECK ("orders"."price" > 0),
	CONSTRAINT "orders_quantity_positive" CHECK ("orders"."quantity" > 0),
	CONSTRAINT "orders_filled_within_quantity" CHECK ("orders"."filled_quantity" >= 0 and "orders"."filled_quantity" <= "orders"."quantity")
);
--> statement-breakpoint
CREATE TABLE "trades" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "trades_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"market" text NOT NULL,
	"maker_order_id" uuid NOT NULL,
	"taker_order_id" uuid NOT NULL,
	"price" numeric(36, 18) NOT NULL,
	"quantity" numeric(36, 18) NOT NULL,
	"engine_sequence" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trades_market_engine_sequence" UNIQUE("market","engine_sequence"),
	CONSTRAINT "trades_price_positive" CHECK ("trades"."price" > 0),
	CONSTRAINT "trades_quantity_positive" CHECK ("trades"."quantity" > 0)
);
--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_market_markets_symbol_fk" FOREIGN KEY ("market") REFERENCES "public"."markets"("symbol") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_market_markets_symbol_fk" FOREIGN KEY ("market") REFERENCES "public"."markets"("symbol") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_maker_order_id_orders_id_fk" FOREIGN KEY ("maker_order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_taker_order_id_orders_id_fk" FOREIGN KEY ("taker_order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "trades_maker_order_id_idx" ON "trades" USING btree ("maker_order_id");--> statement-breakpoint
CREATE INDEX "trades_taker_order_id_idx" ON "trades" USING btree ("taker_order_id");