-- Reference data, not user data: every environment needs exactly these rows.
INSERT INTO "assets" ("code", "scale") VALUES
	('BTC', 8),
	('ETH', 8),
	('USD', 2);
--> statement-breakpoint
INSERT INTO "markets" ("symbol", "base_asset", "quote_asset", "tick_size", "min_quantity") VALUES
	('BTC-USD', 'BTC', 'USD', 0.01, 0.0001),
	('ETH-USD', 'ETH', 'USD', 0.01, 0.001);
