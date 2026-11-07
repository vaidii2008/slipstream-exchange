ALTER TABLE "orders" ADD COLUMN "protection_price" numeric(36, 18);--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_protection_price_matches_type" CHECK (("orders"."type" = 'market') = ("orders"."protection_price" is not null));--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_protection_price_positive" CHECK ("orders"."protection_price" > 0);