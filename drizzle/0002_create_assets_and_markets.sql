CREATE TABLE "assets" (
	"code" text PRIMARY KEY NOT NULL,
	"scale" smallint NOT NULL,
	CONSTRAINT "assets_scale_range" CHECK ("assets"."scale" between 0 and 18)
);
--> statement-breakpoint
CREATE TABLE "markets" (
	"symbol" text PRIMARY KEY NOT NULL,
	"base_asset" text NOT NULL,
	"quote_asset" text NOT NULL,
	"tick_size" numeric(36, 18) NOT NULL,
	"min_quantity" numeric(36, 18) NOT NULL,
	CONSTRAINT "markets_distinct_assets" CHECK ("markets"."base_asset" <> "markets"."quote_asset"),
	CONSTRAINT "markets_tick_size_positive" CHECK ("markets"."tick_size" > 0),
	CONSTRAINT "markets_min_quantity_positive" CHECK ("markets"."min_quantity" > 0)
);
--> statement-breakpoint
ALTER TABLE "markets" ADD CONSTRAINT "markets_base_asset_assets_code_fk" FOREIGN KEY ("base_asset") REFERENCES "public"."assets"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "markets" ADD CONSTRAINT "markets_quote_asset_assets_code_fk" FOREIGN KEY ("quote_asset") REFERENCES "public"."assets"("code") ON DELETE no action ON UPDATE no action;