// One writer per market across processes, not just within one: the market's sequence numbers,
// its book and its settlements all assume a single writer. The exchange takes this lock
// before it replays a market's log, so a second process never reads a log the first is still
// appending to.

import { Client } from "pg";

// Another process holds the market's advisory lock, so it is that process's market to write.
export class MarketLockedError extends Error {
  readonly market: string;

  constructor(market: string) {
    super(`market ${market} is open in another process, which holds its advisory lock`);
    this.name = "MarketLockedError";
    this.market = market;
  }
}

// The connection holding the market's advisory lock dropped, and the lock went with it.
// Another process may now open the market, so this one stops writing it.
export class MarketLockLostError extends Error {
  readonly market: string;

  constructor(market: string, options?: ErrorOptions) {
    super(`market ${market} lost its advisory lock with the connection that held it`, options);
    this.name = "MarketLockLostError";
    this.market = market;
  }
}

export type MarketLock = {
  // Ends the connection, and the lock with it. Not reported as a loss.
  release(): Promise<void>;
};

// A session-level advisory lock lives exactly as long as its connection, which is why the
// connection is dedicated: a pooled one would carry the lock back into the pool. If the
// connection drops, Postgres has released the lock and another process may take the market,
// so onLost is called, once. Throws MarketLockedError if another session holds it.
export async function acquireMarketLock(
  url: string,
  symbol: string,
  onLost: (error: MarketLockLostError) => void,
): Promise<MarketLock> {
  const client = new Client({
    connectionString: url,
    connectionTimeoutMillis: 5000,
    // Names the holder in pg_stat_activity, for whoever finds the market refusing to open.
    application_name: `slipstream market lock ${symbol}`,
  });
  // A connection that fails while idle emits "error", and an unhandled one would crash the
  // process. Both events can follow one drop; clearing `held` makes onLost run once, and
  // release() clears it first so that ending the connection on purpose is not a loss.
  let held = false;
  const lost = (cause?: unknown) => {
    if (held) {
      held = false;
      onLost(new MarketLockLostError(symbol, { cause }));
    }
  };
  client.on("error", lost);
  client.on("end", () => lost());
  await client.connect();

  const result = await client.query<{ locked: boolean }>(
    "select pg_try_advisory_lock(hashtextextended($1, 0)) as locked",
    [`slipstream:market:${symbol}`],
  );
  if (result.rows[0]?.locked !== true) {
    await client.end();
    throw new MarketLockedError(symbol);
  }
  held = true;
  return {
    async release() {
      held = false;
      await client.end();
    },
  };
}
