// The process the recovery test kills (recovery.test.ts). A real exchange on the test
// database, with several users placing, sweeping and cancelling orders in one market as fast
// as it will take them. After each command settles it prints the book as that command left
// it, one JSON line per command, so the test knows exactly what the process had in memory
// when it died.
//
// Usage: node recovery.child.ts <market> <user ids as a JSON array>, with DATABASE_URL set.

import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { Exchange } from "./exchange.ts";
import { loadMarket, OrderError } from "./orders.ts";

const [symbol, users] = process.argv.slice(2);
if (symbol === undefined || users === undefined) {
  throw new Error("usage: node recovery.child.ts <market> <user ids as JSON>");
}
const userIds = JSON.parse(users) as string[];
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle({ client: pool });
const market = await loadMarket(db, symbol);
if (market === undefined) {
  throw new Error(`${symbol} is not a listed market`);
}

const exchange = new Exchange(db);
// Runs inside the market's queue, after the command's settlement has committed and before
// the next command starts, so the book printed is exactly the one this command left.
exchange.onUpdate((update) => {
  const book = exchange.depth(symbol, 100_000);
  const line = JSON.stringify(
    { sequence: update.sequence, bids: book.bids, asks: book.asks },
    (_, v: unknown) => (typeof v === "bigint" ? String(v) : v),
  );
  process.stdout.write(`${line}\n`);
});
await exchange.open([market]);

const pick = (n: number) => Math.floor(Math.random() * n);

// Prices within ten ticks of 60,000, so orders cross often; up to 50 steps of quantity.
async function trade(userId: string): Promise<never> {
  const resting: string[] = [];
  for (;;) {
    const roll = Math.random();
    const side = Math.random() < 0.5 ? "buy" : "sell";
    const quantity = BigInt(1 + pick(50)) * market!.quantityStep;
    try {
      if (roll < 0.15 && resting.length > 0) {
        const [orderId] = resting.splice(pick(resting.length), 1);
        await exchange.cancelOrder(market!, orderId!);
      } else if (roll < 0.25) {
        await exchange.placeOrder(market!, { type: "market", userId, side, quantity });
      } else {
        const price = 60_000_00000000n + BigInt(pick(21) - 10) * market!.tickSize;
        const placed = await exchange.placeOrder(market!, {
          type: "limit",
          userId,
          side,
          price,
          quantity,
        });
        if (placed.status === "open") {
          resting.push(placed.id);
        }
      }
    } catch (error) {
      // A market order into an empty side is refused; anything else is a failure the test
      // should see, so it ends the process.
      if (!(error instanceof OrderError)) {
        throw error;
      }
    }
  }
}

await Promise.all(userIds.map((userId) => trade(userId)));
