import { describe, expect, it } from "vitest";
import type { MarketInfo } from "./markets";
import { checkOrder, type OrderDraft } from "./orders";

const btc: MarketInfo = {
  symbol: "BTC-USD",
  baseAsset: "BTC",
  quoteAsset: "USD",
  tickSize: "0.01000000",
  quantityStep: "0.00010000",
  minQuantity: "0.00010000",
};

const limit = (price: string, quantity: string): OrderDraft => ({
  side: "buy",
  type: "limit",
  price,
  quantity,
});

describe("checkOrder", () => {
  it("accepts an order on the grid", () => {
    expect(checkOrder(btc, limit("65000.01", "0.0001"))).toEqual({});
    expect(checkOrder(btc, limit("65000.10000", "1.50000000"))).toEqual({});
  });

  it("rejects a price off the tick and a quantity off the step", () => {
    expect(checkOrder(btc, limit("65000.001", "0.00015"))).toEqual({
      price: "must be a multiple of 0.01",
      quantity: "must be a multiple of 0.0001",
    });
  });

  it("rejects a zero price and a quantity under the minimum", () => {
    expect(checkOrder(btc, limit("0", "0"))).toEqual({
      price: "must be positive",
      quantity: "must be at least 0.0001",
    });
  });

  it("rejects what is not a plain decimal, floats' notation included", () => {
    expect(checkOrder(btc, limit("1e5", "-1"))).toEqual({
      price: "must be a plain decimal such as 1.5",
      quantity: "must be a plain decimal such as 1.5",
    });
  });

  it("ignores the price of a market order", () => {
    expect(checkOrder(btc, { side: "sell", type: "market", price: "", quantity: "0.5" })).toEqual(
      {},
    );
  });
});
