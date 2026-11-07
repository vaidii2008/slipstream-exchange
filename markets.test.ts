import { eq, notLike } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { fromNumeric } from "./money.ts";
import { assets, markets } from "./schema.ts";
import { useTestServer } from "./testing.ts";

const { db } = useTestServer();

const base = alias(assets, "base");
const quote = alias(assets, "quote");

// Reads the markets the migrations actually seeded, so a future migration that adds a market
// or changes a scale is checked by the same rules. Test markets (BTC-USD-1a2b3c4d), which
// other files create while this runs, are left out.
async function listedMarkets() {
  return db
    .select({
      symbol: markets.symbol,
      tickSize: markets.tickSize,
      quantityStep: markets.quantityStep,
      minQuantity: markets.minQuantity,
      baseScale: base.scale,
      quoteScale: quote.scale,
    })
    .from(markets)
    .innerJoin(base, eq(base.code, markets.baseAsset))
    .innerJoin(quote, eq(quote.code, markets.quoteAsset))
    .where(notLike(markets.symbol, "%-%-%"))
    .orderBy(markets.symbol);
}

describe("market precision", () => {
  it("lists BTC-USD and ETH-USD with the approved tick and step", async () => {
    const rows = await listedMarkets();

    expect(rows.map((row) => [row.symbol, row.tickSize, row.quantityStep])).toEqual([
      ["BTC-USD", "0.010000000000000000", "0.000100000000000000"],
      ["ETH-USD", "0.010000000000000000", "0.001000000000000000"],
    ]);
  });

  // price is in quote minor units and quantity in base minor units, so a fill's notional in
  // quote minor units is price × quantity / 10^baseScale. The smallest possible fill, one tick
  // × one step, must divide exactly; every larger fill is a whole multiple of it.
  it("makes one tick × one step a whole number of quote minor units in every market", async () => {
    const rows = await listedMarkets();

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const tick = fromNumeric(row.tickSize, row.quoteScale);
      const step = fromNumeric(row.quantityStep, row.baseScale);

      expect({
        symbol: row.symbol,
        remainder: (tick * step) % 10n ** BigInt(row.baseScale),
      }).toEqual({ symbol: row.symbol, remainder: 0n });
    }
  });

  it("makes every minimum quantity a whole number of steps", async () => {
    const rows = await listedMarkets();

    for (const row of rows) {
      const step = fromNumeric(row.quantityStep, row.baseScale);
      const minimum = fromNumeric(row.minQuantity, row.baseScale);

      expect({ symbol: row.symbol, remainder: minimum % step }).toEqual({
        symbol: row.symbol,
        remainder: 0n,
      });
    }
  });
});
