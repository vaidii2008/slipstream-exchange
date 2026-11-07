# Decisions

Each entry: the decision, the alternative, why, and where it lives.

## Auth and sessions

### A replayed refresh token revokes its whole family

- **Decision:** refresh tokens are single use. Presenting one that was already used revokes every
  token from the same login, including the newest.
- **Alternative:** reject only the replayed token and leave the rest of the chain alive.
- **Why:** a replay means two parties hold the same token, and the server cannot tell the thief
  from the user. Killing the family logs both out; the user signs in again and the thief cannot.
- **Where:** `rotateSession` in `sessions.ts`; tests in `sessions.test.ts`.

### Two concurrent refreshes count as reuse

- **Decision:** when two requests refresh with the same token at once, the row lock lets one win
  and the loser is treated as a replay, so the family is revoked.
- **Alternative:** a short grace window (Auth0 style) in which the previous token still returns the
  same successor.
- **Why:** the grace window needs extra state and widens the window a thief can use. The cost is
  that two browser tabs refreshing in the same instant log the user out. The test
  `lets one of two concurrent refreshes win` pins this behaviour.
- **Where:** the `UPDATE ... WHERE used_at IS NULL` in `rotateSession`, `sessions.ts`.

### Logout revokes the family, not just the presented token

- **Decision:** `POST /session/logout` revokes every unrevoked token sharing the presented token's
  family, even if the presented token is an old, already-rotated one.
- **Alternative:** revoke only the exact token presented.
- **Why:** a client holding a stale token after a rotation would otherwise "log out" while its
  current token stays valid.
- **Where:** `endSession` in `sessions.ts`.

## API

### Client errors return a message, server errors return only a code

- **Decision:** one central error handler. 4xx errors return `{ error, message }`; anything else
  returns `{ error: "internal_error" }` and the detail goes only to the log under the request id.
- **Alternative:** hide every message, or return every message.
- **Why:** Fastify's 4xx messages describe the client's own mistake (malformed JSON), which a
  client needs. A 5xx comes from our code or the database driver and can carry SQL or stored
  values.
- **Where:** `setErrorHandler` in `server.ts`; tests under `central error handling` in
  `server.test.ts`.

### Connections close in Fastify's onClose hook on shutdown

- **Decision:** on SIGTERM or SIGINT, `app.close()` runs; Redis and the Postgres pool close in an
  `onClose` hook, with a 10 second forced exit.
- **Alternative:** close the pool directly in the signal handler.
- **Why:** `onClose` runs only after in-flight requests finish, so no request loses its database
  mid-query. Checked by hand: a login in flight at SIGTERM still returned its 401 before exit 0.
- **Where:** `shutDownOn` and the `onClose` hook in `main.ts`.

## Money and the ledger

### Amounts are rejected, never rounded, at the boundary

- **Decision:** a client sends amounts as decimal strings. `parseAmount` turns them into bigint
  minor units at the asset's scale and rejects anything with more decimals than the scale allows,
  as well as negatives, exponents and values past NUMERIC(36,18).
- **Alternative:** accept JSON numbers, or round extra decimals to the scale.
- **Why:** a JSON number has been through a float before our code sees it (`0.1` is not 0.1), and
  rounding silently changes what the client asked for. A 400 tells them.
- **Where:** `parseAmount` in `money.ts`; the only other conversions, `fromNumeric` and
  `formatAmount`, live in the same file.

### The entries are the truth; each account caches their sum

- **Decision:** `ledger_accounts.balance` holds the sum of the account's entries.
  `postTransaction` moves it by the net of its entries in the same transaction, under the
  account's row lock, and the overdraft check reads it instead of summing. The migration that
  added it backfilled it from the entries. Balance reads (`balancesOf`, `accountState`) still sum
  the entries. Until 7 November there was no column.
- **Alternative:** no column, summing on every check (the original design); or periodic balance
  checkpoints, which bound the sum but add a second table and a second rule for what a balance is.
- **Why:** summing made every debit check scale with the account's history. Throughput fell from
  250 to 123 commands/s over a 1M-command fill. With the cache, on a ledger of 3.6M entries,
  saturated throughput rose from 179–212 to 269–300 commands/s (see Measurement). The risk of a
  second copy is drift, so a test runs 8 users trading and cancelling in two markets at once,
  then checks every account in the database, in one statement, for a cached balance that
  differs from its entries. With releases skipping the update, it finds 16.
- **Where:** `postTransaction` in `ledger.ts`; `0012_cache_account_balances.sql`; the "cached
  balance" tests in `ledger.test.ts` and `exchange.test.ts`.

### Lock every account a transaction touches, in id order, with FOR NO KEY UPDATE

- **Decision:** `postTransaction` locks every account its postings name, debited or credited, the
  system account included, with one `SELECT ... FOR NO KEY UPDATE` sorted by id. That statement
  also returns the cached balances, and debits are checked against them. Until 7 November only
  user accounts with a net debit were locked.
- **Alternative:** lock only the debited accounts (the original rule), lock in posting order, or
  use `FOR UPDATE`.
- **Why:** updating the cached balance takes the row's lock anyway, on credited accounts too.
  Taken one by one by the UPDATE, those locks would be taken in whatever order the rows were
  listed. Taken up front by id, two transactions touching the same accounts always ask in the
  same order and queue. Forty trades in opposite directions between two users, each touching
  all four of their BTC accounts, finish with 0 failures. Locking in posting order instead gave
  29 deadlocks (40P01) out of 40. The cost is that deposits of one asset now queue on its system
  account's row. Deposits are rare next to orders. The lock strength still matters. Inserting an
  entry takes `FOR KEY SHARE` on the referenced account for the foreign key, and `FOR UPDATE`
  blocks that. Under the original debit-only rule, 36 of 40 interleaved reserves and releases
  died with 40P01. `FOR NO KEY UPDATE` does not block it, and it is also the lock a plain UPDATE
  takes, so the cache's own update never upgrades it. 50 parallel reservations of 10 against
  100 still give exactly 10 successes.
- **Where:** `lockAccounts` and `postTransaction` in `ledger.ts`; tests under `concurrent
reservations` and `the cached balance` in `ledger.test.ts`.

### The ledger never cascades

- **Decision:** no foreign key into or inside the ledger has `ON DELETE CASCADE`, so a user with
  ledger history cannot be deleted.
- **Alternative:** cascade from `users`, like `refresh_tokens` does.
- **Why:** deleting a user would silently delete half of every transaction they took part in,
  and the system account and counterparties would stop balancing. Tests delete whole
  transactions explicitly before deleting their users.
- **Where:** `ledgerAccounts` and `ledgerEntries` in `schema.ts`; `deleteTradingHistory` in
  `testing.ts`.

### USD at scale 8, and every market has a quantity step

- **Decision:** USD is counted to 8 decimals. Each market has a `quantity_step` (BTC-USD 0.0001,
  ETH-USD 0.001) next to its tick. A price must be a whole number of ticks, a quantity a whole
  number of steps.
- **Alternative:** keep USD at 2 decimals and round each fill's notional with a rule such as
  banker's rounding, or charge the rounding to one side.
- **Why:** at 2 decimals, one step at one tick is worth 0.000001 USD, so most fills would need
  rounding, and every rounding rule moves value between users. At scale 8 that fill is 100
  minor units, and every fill is a whole multiple of it. `notional()` throws instead of
  rounding, so an order off the grid fails loudly. A test checks tick × step against every
  seeded market.
- **Where:** migration `0005`; `notional` in `money.ts`; `markets.test.ts`.

## Matching engine

### Price levels in a sorted array, best price last

- **Decision:** each side of the book is an array of price levels sorted worst-first, so the best
  level is the last element. A binary search places new levels; each level is an array of orders
  in arrival order, and an id index finds any order for cancel.
- **Alternative:** a balanced tree or skip list keyed by price, and a linked list per level.
- **Why:** reading and emptying the best level, which every match does, is `at(-1)` and `pop()`.
  Inserting a new level costs a splice, but a book has tens of active levels, not millions. The
  per-level `shift()` is O(n) in the queue length; Session 4's benchmark decides whether that
  matters before anything fancier goes in.
- **Where:** `OrderBook` in `book.ts`.

### Baseline: no engine optimisation, because the numbers show no hotspot

- **Decision:** keep arrays for price levels and queues. `npm run bench` (Apple M4, Node 24.21,
  1,000,000 timed commands, seed 20261106, two runs):
  - **Mixed book**, held near 5,000 resting orders: about 4.4 million commands/s; p50 0.17 µs,
    p99 0.58 µs.
  - **One price level held near 10,000 orders**: about 2.28 million commands/s. Cancels p50
    1.25 to 1.29 µs and p99 1.54 to 1.71 µs. Fills from the front p50 0.21 µs.
- **Alternative:** a doubly linked list per level, so a cancel unlinks in O(1) instead of
  scanning the level with `indexOf`.
- **Why:** the scan is visible, a cancel costs about 6 times a fill on a deep level, but it is
  1.3 µs. Settling one order in Postgres takes milliseconds, so the engine is not the
  bottleneck. A first version of the benchmark let the level grow to 137,000 orders and showed
  cancels at 180 µs p99; that was the generator's bug, not the engine's. Maximums of 1 to 8 ms
  in every run are garbage-collection pauses, not slow paths.
- **Where:** `engine.bench.ts`; the scan is `OrderBook.remove` in `book.ts`.

### Self-trade prevention cancels the incoming order

- **Decision:** when the next maker in priority belongs to the taker's own user, matching stops and
  the taker's remainder is cancelled with reason `self_trade`. Earlier fills stand.
- **Alternative:** cancel the resting order (cancel-oldest), cancel both, or skip past it to the
  next maker.
- **Why:** the resting order earned its queue position and the user may be relying on it, while
  the incoming order is the one that just made the mistake. Skipping past it would let a taker
  trade at a worse price than one already on the book, which breaks price priority.
- **Where:** the `selfTrade` check in `Engine.#match`, `engine.ts`.

### Cancelling a missing order is an event, not an exception

- **Decision:** `Engine.cancel` on an id that is not resting returns a `cancel_rejected` event.
  Bad input (a zero quantity, a reused id) throws.
- **Alternative:** throw for both, or ignore the missing cancel silently.
- **Why:** a cancel that arrives just after the fill that emptied the order is normal under load,
  and the client needs to hear about it. A zero quantity reaching the engine means validation
  upstream failed, which is a bug.
- **Where:** `Engine.cancel` in `engine.ts`.

### Interview note: Session 3, the matching engine

The problem was matching orders fairly, by best price first and then arrival time, while
staying deterministic so that a book can later be rebuilt by replaying the same commands. The
engine is a pure TypeScript class per market, with no clock, no I/O and no randomness, and it
emits typed events numbered 1, 2, 3, ... per market, stamped only once a command completes. The
trade-off is that it has to run behind one serial queue per market, so one market's throughput
is limited to one core, which buys a book with exactly one writer and no locks. fast-check runs
1,500 generated sequences of up to 200 limit, market and cancel commands, with a median near 90,
and checks after every step that the book is uncrossed, that every order's quantity is
accounted for, that no user trades with themselves, and that replaying the same commands gives
identical events. Four bugs injected by hand (trading past the limit, no self-trade check, a
market remainder dropped, sells resting without matching) each failed exactly the property
meant to catch it.

## Orders and settlement

### Reserve and record first, then match and settle in a second transaction

- **Decision:** placing an order is two Postgres transactions. The first reserves what the
  order could spend and inserts it as `pending`. Then, in the market's queue, the engine
  matches it and a second transaction writes everything the engine did: trades, ledger
  postings and order statuses.
- **Alternative:** one transaction around reserve, match and settle; or match first and
  reserve after.
- **Why:** the engine is in memory and cannot roll back, so it must only see orders that are
  already funded. Matching first could produce a trade that one side cannot pay for. One big
  transaction would hold row locks while waiting for the queue. The cost is a window where a
  crash leaves an order `pending` and reserved; Session 10's recovery handles that.
- **Where:** `recordLimitOrder` in `orders.ts`; `Exchange.placeLimitOrder` and `settle` in
  `exchange.ts`.

### One serial queue per market covers the engine and its settlement

- **Decision:** a market's queue task is "submit to the engine, then commit the settlement",
  and the next task starts only after that commit (or failure).
- **Alternative:** queue only the synchronous engine call and settle in the background.
- **Why:** two settlements in flight at once could commit in the opposite order to the events
  they record, for example a later fill's status update landing before the earlier one's.
  The cost is that one market's throughput is bounded by settlement latency in Postgres, not
  by the engine's 2 to 4 million commands per second. Session 11 measures how much.
- **Where:** `SerialQueue` and `Exchange` in `exchange.ts`.

### A settlement locks every account it touches up front, in id order

- **Decision:** before posting any fill, `settle` collects every account the command touches
  (both sides of every fill and every released remainder) and locks them all at once with
  `lockAccounts`, sorted by id. Until the cached balance on 7 November it locked only the
  accounts it debited.
- **Alternative:** let each fill's `postTransaction` lock its own accounts as it goes.
- **Why:** markets settle in parallel. A BTC-USD sell filling two buyers in one order and an
  ETH-USD sell filling the same buyers in the other order took the two USD reserved locks in
  opposite orders. With the up-front lock removed, the test that sets this up deadlocked in 5
  of 5 runs; with it, 0 of 5.
- **Where:** `lockAccounts` in `ledger.ts`; `settle` in `exchange.ts`; the "without
  deadlocking" test in `exchange.test.ts`.

### A buyer's unused reservation is returned at each fill

- **Decision:** a buy reserves at its own limit. When it fills at a lower maker price, the
  fill's ledger transaction returns the difference to the buyer's available balance.
- **Alternative:** leave the excess reserved until the order finishes or is cancelled.
- **Why:** it keeps one rule true at every moment: an open buy has exactly remaining quantity
  × limit reserved. That makes the reservation checkable from the order row alone, and the
  user can spend the improvement straight away.
- **Where:** `fillPostings` in `exchange.ts`.

### Trades are not unique on (market, engine_sequence) yet

- **Decision:** dropped the unique constraint in migration `0007`, one migration after adding
  it.
- **Alternative:** keep it and seed each engine's sequence from `max(engine_sequence)` at
  startup.
- **Why:** an engine numbers from 1 every time the process starts, so the first trade after a
  restart collided with an old one. The tests caught it, because each test's fresh exchange
  collided with the previous test's trades. Seeding the sequence from the trades table alone
  would be half of recovery, since the book would still be empty. The constraint comes back
  in Session 10 with the event log.
- **Where:** `trades` in `schema.ts`; migrations `0006` and `0007`.
- **Update (Day 14):** restored in migration `0011`; see "Durability and recovery".

## Order lifecycle

### A market order gets a protection price 5% beyond the best opposite price

- **Decision:** on arrival, a market order is bounded at the best opposite price moved 5%
  against the taker, rounded onto the tick grid. A buy reserves quantity × that price, and the
  engine stops matching at it and cancels the rest.
- **Alternative:** reserve the user's whole available balance, or ask the client for a
  maximum spend.
- **Why:** a market buy has no price, so without a bound there is nothing to reserve and a
  thin book could fill it at any price. The bound makes the reservation exact and protects the
  user from sweeping a book far past where it stood. The cost is that the part of an order
  beyond 5% is cancelled, not filled.
- **Where:** `protectionPrice` in `orders.ts`; `MarketOrder.protectionPrice` in `engine.ts`.

### Idempotency: insert the order before reserving, and let the unique index decide

- **Decision:** `recordOrder` inserts the order row first, with `ON CONFLICT DO NOTHING` on
  (user, client order id), and reserves only if the insert went in. A repeat gets the original
  order back with 200; the same key on a different order gets 409.
- **Alternative:** reserve first and insert after, or check for the key and then insert.
- **Why:** a second insert with the same key waits on the index until the first commits, then
  conflicts, so repeats are serialised by Postgres. Reserving first, a repeat could fail for
  insufficient funds that the original had just taken. Six parallel identical sells against a
  balance that funds one: one order, five duplicates, one reservation.
- **Where:** `recordOrder` in `orders.ts`; `replyToRepeat` in `trading.ts`.

### Public market data is aggregated inside the book

- **Decision:** `OrderBook.depth` sums each price level to a price and a total quantity, and
  the routes build every response field by field. No user id or order id leaves the API on a
  public route.
- **Alternative:** take `snapshot()` (which carries `userId` and order ids) and strip fields
  in the route.
- **Why:** stripping is a filter that a later field can slip past. Aggregating where the data
  lives means the per-order data never reaches the route. The tests check that the response
  body contains none of the users' or orders' ids.
- **Where:** `depth` in `book.ts`; `market.ts`.

### A fixed-window rate limit on Redis that fails open

- **Decision:** `INCR` and `PEXPIRE NX` in one `MULTI`, on a key holding the user and the
  window number; 20 orders per user per second by default. If Redis is unreachable the order
  goes ahead and the error is logged.
- **Alternative:** a sliding window or token bucket; failing closed.
- **Why:** it is one round trip and easy to reason about. Its weakness is written down as a
  test: a full allowance at the end of one window and another at the start of the next is
  2 × limit within 2 ms. It fails open because the limiter guards against runaway clients, not
  correctness, and the queue cap bounds load either way.
- **Where:** `ratelimit.ts`; `underOrderLimit` in `trading.ts`.

### Fail-stop: a failed settlement halts its market

- **Decision:** if a settlement throws, the market is marked halted, logged at fatal, and
  every later command for it gets 503 `market_halted` until restart. Other markets trade on.
- **Alternative:** keep trading, or try to undo the engine's change.
- **Why:** the engine has already matched and cannot roll back, so its book and Postgres now
  disagree. Matching more orders against that book would build trades on a state the ledger
  never recorded. Stopping one market is cheaper than repairing a ledger. Session 10's replay
  is what brings it back.
- **Where:** `#execute` and `MarketHaltedError` in `exchange.ts`.

### The queue cap counts from admission, not from enqueue

- **Decision:** each market admits at most 10,000 commands that have not finished. A command
  counts from before its reservation until it settles, fails or is refused. Past the cap: 503
  `market_busy` with `Retry-After: 1`.
- **Alternative:** cap the `SerialQueue` itself.
- **Why:** the order is reserved in Postgres before it is enqueued. A queue that refused it
  then would leave a reservation with no command to settle it. Counting from admission means a
  refused order has reserved nothing.
- **Where:** `#admitted` and `MarketBusyError` in `exchange.ts`.

### Interview note: Session 5, the order lifecycle

The problem was keeping money correct when a client retries, two requests race, a settlement
throws after the in-memory engine has already matched, or a burst outruns Postgres. Each case
got one rule: idempotency keys serialised by a unique index, a protection price that bounds
what a market order reserves, fail-stop on a failed settlement, and a per-market admission cap.
The trade-off is availability for correctness: a market whose settlement fails stops until
restart, and a busy one turns clients away with 503 rather than queueing without bound. Five
identical requests at once give one 201, four 200s and one reservation. A settlement forced to
fail leaves the ledger summing to zero and the buy pending and reserved with no trade written,
while BTC-USD refuses the next order and ETH-USD still accepts one.

## Real-time market data

### The rate limiter gives up after 100 ms and refuses while Redis is reconnecting

- **Decision:** the API's Redis client has no offline queue. The limiter also refuses on its
  own when the client is not ready, and gives up after 100 ms; either way the order goes
  ahead.
- **Alternative:** rely on `disableOfflineQueue` alone.
- **Why:** with the offline queue, POST /orders hung for as long as Redis was down, and the
  waiting commands grew without bound. node-redis 6 checks `disableOfflineQueue` only for
  single commands and still queues a `MULTI`. A slow but connected Redis is not offline at
  all, so only a timeout covers it. Before the fix both cases hung until the test timed out
  at 5 s; after it, the tests require under 50 ms (down) and under 300 ms (slow).
- **Where:** `hitFixedWindow` in `ratelimit.ts`; `createRedisClient` in `redis.ts`.

### The book channel is a snapshot plus deltas that carry absolute level totals

- **Decision:** subscribing sends the whole book with its sequence. Each delta carries the
  command's first and last sequence and the new total at every level it changed. A client
  drops deltas at or below what it has; a `firstSequence` other than last + 1 is a gap, and
  subscribing again re-sends the snapshot.
- **Alternative:** deltas as increments (+0.1 at 60,000), or a separate resync endpoint.
- **Why:** an absolute total means a delta applied twice does no harm, and the first and last
  sequence mean a command that emitted several events still reads as one contiguous step.
  Resync reuses subscribe, so a client has one code path for joining and for recovering.
- **Where:** `bookUpdate` in `feed.ts`; `levelsTouched` in `engine.ts`; `#announce` in
  `exchange.ts`.

### Market data publishes are fire and forget

- **Decision:** the exchange's update listener publishes to Redis without awaiting it. A
  failed publish is logged and dropped.
- **Alternative:** await each publish inside the market's queue, or retry.
- **Why:** awaiting would make every order wait on Redis, and a slow Redis would stall
  matching. Retrying would need a buffer, which an outage would make unbounded. The sequence
  numbers already let a client detect a loss and resync from the engine's own book. The gap
  test drops a real publish during a cut connection and the client converges.
- **Where:** `publishUpdate` in `feed.ts`; the gap test in `ws.test.ts`.

### A balances message carries a version: the highest ledger entry id it includes

- **Decision:** after an order event for a connected user, the gateway reads their balances
  together with `max(ledger_entries.id)` in one statement, and the client keeps the message
  with the highest version.
- **Alternative:** send balances from inside the market's queue, or send deltas.
- **Why:** two markets can settle for the same user at once, so two balance reads can
  finish in either order. Entry ids only grow, so the higher version saw at least what the
  other did. Reading at the gateway also means only users with a connection cost a query.
- **Where:** `accountState` in `ledger.ts`; `sendBalances` in `ws.ts`.

### Slow and dead sockets are terminated, not buffered for

- **Decision:** ping every 15 s and terminate a connection that missed the previous pong.
  Terminate any connection with more than 1 MiB unsent.
- **Alternative:** let the operating system time out dead connections; let the buffer grow.
- **Why:** a dead network path never sends a close, so without pings its subscriptions live
  forever. A client that reads slower than the market moves would make the server's memory
  grow with every update. Terminate rather than close, because a close frame would queue
  behind the backlog it is meant to stop.
- **Where:** `Connection.sendText` and the heartbeat in `registerWebSocketRoutes`, `ws.ts`.

### Interview note: Session 6, real-time market data

The problem was streaming a live order book to many clients without the stream ever
silently diverging from the engine, and without one slow client, a dead connection or a Redis
outage holding up matching. Each settled command becomes one delta with absolute level totals
and its first and last sequence. It is published fire and forget through Redis to the socket
gateways, and a client that sees a sequence jump resubscribes for a fresh snapshot. The
trade-off is that delivery is at most once: a publish lost in an outage is not retried, and
the client pays a snapshot to recover instead of the exchange paying an unbounded buffer. In
the gap test a real publish is lost while the connection is cut; the client counts exactly
one gap, resyncs at sequence 3, and ends with the same three ask levels the REST endpoint
reports.

## Trading terminal

### The terminal calls the API directly across origins, not through a Next.js proxy

- **Decision:** the web app on port 3001 calls the API on 3000 with `credentials: "include"`.
  `@fastify/cors` allows exactly one origin, `WEB_ORIGIN`, with credentials.
- **Alternative:** proxy the API through Next.js rewrites under `/api`, which avoids CORS.
- **Why:** the refresh cookie has `Path=/session`, so the browser would never send it to
  `/api/session/refresh` and silent refresh would fail. A wildcard origin is not possible
  either, since browsers refuse credentials with `*`.
- **Where:** the `cors` registration in `server.ts`; `WEB_ORIGIN` in `config.ts`.

### The access token lives in memory, and refreshes never race

- **Decision:** the access token is a module variable, never in localStorage. A reload trades
  the httpOnly refresh cookie for a new one. Within a tab, concurrent callers share one
  in-flight refresh; across tabs, refreshes take turns under a Web Lock.
- **Alternative:** localStorage (any injected script can read it), or refresh without
  coordination.
- **Why:** the API rotates the refresh token and revokes the whole family when one is used
  twice. Two refreshes that send the same cookie would log the user out everywhere.
- **Where:** `refreshAccessToken` and `acrossTabs` in `web/lib/session.ts`.

### The socket resubscribes to what the page wants, on every connection

- **Decision:** the client keeps a reference-counted set of wanted topics. Each connection
  authenticates and subscribes to all of them; drops retry with exponential backoff and
  jitter, capped at 10 s. Close code 4001 refreshes the token and reconnects at once.
- **Alternative:** track what the server confirmed and replay only the difference.
- **Why:** one path for the first connection and every reconnect, and a book subscription
  always brings a fresh snapshot, so a reconnect is also a resync. The jitter stops every
  tab from reconnecting in the same instant after an API restart.
- **Where:** `MarketSocket` in `web/lib/socket.ts`.

### Book rows re-render alone: the price list changes identity only when levels change

- **Decision:** the book store keeps the sorted prices per side apart from a quantity map
  keyed by side and price. The book component reads only the price lists; each memoised row
  reads its own quantity.
- **Alternative:** keep the book as one array of levels and render it from the top.
- **Why:** most updates change the size at an existing price. In a browser check, changing
  the size at one level rendered that one row and not the book component.
- **Where:** `applyUpdate` in `web/lib/book.ts`; `Row` in `web/components/order-book.tsx`.

### A draft order keeps its client order id until it changes

- **Decision:** the form creates a client order id per draft. A failed submit keeps it; an
  edit or a placed order replaces it.
- **Alternative:** a new id per click, or none.
- **Why:** after a timeout the trader cannot know whether the order landed. Resubmitting the
  same id makes the API return the first order instead of placing a second.
- **Where:** `edit` and the mutation in `web/components/order-form.tsx`.

### The account channel waits for the server's "authenticated" reply

- **Decision:** the socket sends the account subscription only after the server answers
  the auth with "authenticated", once per connection. Public channels go out at once.
- **Alternative:** send auth and subscribe back to back, relying on the server handling one
  connection's messages in order.
- **Why:** that order holds on a fresh connection, but logging in while connected sends the
  auth after an async token read, and the balances panel can subscribe first. The server
  refuses it and nothing retries. The reply cannot arrive before the auth was accepted.
- **Where:** `#sendIfReady` and the `authenticated` branch of `#receive` in `web/lib/socket.ts`.

### Order state from REST and the socket is merged by taking whichever is further along

- **Decision:** open orders come from `GET /orders` and are patched by order events. Of two
  reports about one order, the terminal keeps the later status (pending, open, then filled
  or cancelled) and the larger filled quantity.
- **Alternative:** let the last report to arrive win, or tag REST rows with the engine
  sequence and compare that.
- **Why:** a list read just before a fill can land after the fill's event; last-arrival
  would move the order backwards. An order only moves forward, so the merge gives the same
  answer in any arrival order and needs no API change. A unit test reduces the same reports
  forwards and backwards and gets one answer.
- **Where:** `furthest` in `web/lib/account.ts`; `useOpenOrders` in `web/lib/history.ts`.

## Candles

### Candles are computed from trades, never stored

- **Decision:** history is one `GROUP BY` minute over `trades` (`date_bin`, with open and
  close picked by trade id). The candle in progress is kept in memory by the process that
  settles the market, folded one trade at a time, and loaded from Postgres at boot.
- **Alternative:** a `candles` table updated in the settlement transaction.
- **Why:** a second copy of every trade has to be kept in step and migrated. No new table
  means no data-model change. A test checks that the SQL gives the same candles as folding
  the same trades one by one. The cost of a scan per history read is bounded by the time
  window below.
- **Where:** `loadCandles`, `addTrade` and `LiveCandles` in `candles.ts`.

### A command's trades are stored at the time the feed reports

- **Decision:** the exchange takes one timestamp per command before settling, writes it as
  each trade's `created_at` and sends the same value on the feed.
- **Alternative:** keep Postgres's `now()` default for stored trades and a separate time
  taken after commit for the feed.
- **Why:** the two clocks differed by milliseconds (9 ms in the failing test), so a trade
  near a minute boundary could land in one candle live and in the next after a reload. One
  time per command also means a command's trades never span two minutes.
- **Where:** `#execute` in `exchange.ts`, `settle` in `settlement.ts`.

### The live candle is sent whole, and the copy with more trades wins

- **Decision:** after each command that trades, the server sends the whole candle in
  progress. The terminal keeps whichever copy of a minute, from REST or from the socket,
  has more trades.
- **Alternative:** stream trades and let the terminal fold them into the REST candles,
  dropping duplicates by engine sequence.
- **Why:** sequences restart at 1 when the API restarts, so they cannot order copies across
  a restart, and folding a trade twice double-counts its volume. A candle only ever gains
  trades, so the count orders the copies in any arrival order. A restart mid-minute was
  checked by hand: the next candle went from 2 trades to 3, not back to 1.
- **Where:** `candleMessages` in `feed.ts`; `mergeCandles` in `web/lib/candles.ts`.

### Candle history reads a time window, not the latest N candles

- **Decision:** a history read covers the `limit` minutes before `before` (up to the current
  minute without it), through an index on `trades (market, created_at)`. A minute with no
  trades has no candle, so a page can hold fewer than `limit`.
- **Alternative:** keep "the latest `limit` candles", which skips empty minutes but has to
  group every trade in the market before it can tell which candles are the latest.
- **Why:** on a copy of the dev database with 200,000 BTC-USD trades, the default read went
  from a parallel sequential scan with a 7.7 MB on-disk sort in 23.5 ms to an index scan of
  2,309 rows in 2.0 ms. The index alone did not help the old query (33.8 ms, still a
  sequential scan): it needs the time bound to have something to seek to.
- **Where:** `loadCandles` in `candles.ts`; migration `0008`.

## Trading bots

### Bots are ordinary API clients, reading by REST polling

- **Decision:** every agent registers its own account and trades over the public REST API,
  reading the last trade, its balances and its open orders at the start of each tick.
- **Alternative:** call the engine in process, or mirror the book from the socket.
- **Why:** an in-process bot would skip validation, rate limits, reservation and
  settlement, so it would prove nothing about them. Polling once a second is far below the
  20 orders/second limit and needs no second copy of the socket's gap recovery. The cost is
  up to a tick of staleness, which a noise trader and a wide maker can afford.
- **Where:** `ApiClient` in `bots.ts`.

### Risk limits sit outside the strategy and count resting orders as filled

- **Decision:** a strategy only sees a `RiskGuard`, which refuses an order locally if it is
  too large, past the resting cap, or would move inventory past the position limit if it
  and every resting order on its side filled. A loss limit and a failed-tick limit trip a
  kill switch that cancels everything and stops the agent for good.
- **Alternative:** let each strategy check its own limits, or count only filled inventory.
- **Why:** a limit inside the strategy fails with the strategy's bug. Counting only fills
  lets an agent rest enough bids to blow through the limit in one sweep.
- **Weakness:** equity is marked at the last trade, so one trade at an outlier price can kill
  a maker. The fleet test hit this when other test files traded BTC-USD at 60,000 while the
  maker held 2 BTC. A mark from the book's mid would be steadier.
- **Where:** `RiskGuard`, `equity` and `Agent` in `bots.ts`.
- **Update (Day 14):** the mark is now the median of the last 20 trades; see below.

### The maker skews by inventory and sends only the difference

- **Decision:** the maker shifts its whole ladder against its inventory, in proportion to its
  distance from target and capped, and stops quoting the side that adds inventory once at
  the cap. Each tick cancels only the quotes that changed, before placing the new ones.
- **Alternative:** cancel everything and requote every tick.
- **Why:** unchanged quotes keep their place in the queue and the book does not flash empty.
  Cancelling first means a new bid can never cross an old ask of its own, which
  self-trade prevention would answer by cancelling the bid.
- **Where:** `makerQuotes` and `marketMaker` in `strategies.ts`.

### Equity is marked at the median of the last 20 trades

- **Decision:** a bot's equity values its base at the median of the newest 20 trade prices,
  or at the last trade while a market has fewer than 20.
- **Alternative:** the last trade (what it was), or the mid of the book.
- **Why:** one off-price fill cannot move a median of 20, so it cannot trip a maker's loss
  limit; the test puts 60,000 on top of nineteen trades at 70,000 and the maker keeps running.
  The mid needs a two-sided book and moves every time the maker requotes its own quotes.
- **Where:** `markFrom` and `equity` in `bots.ts`.

## Durability and recovery

### Every engine command is logged before the engine applies it

- **Decision:** inside the market's queue, a command is validated against the engine, appended
  to `engine_events` keyed on (market, sequence), applied, then settled. Its sequence is the
  number its first event gets. Any failure after the append halts the market.
- **Alternative:** log the command in the settlement's transaction, so log and settlement
  commit together.
- **Why:** with the log first, a command that committed to the log has happened, whatever
  fails next, and replay can always finish it. Logging inside the settlement would make a
  crash simpler, but the log would then only record what Postgres already holds: it could
  not rebuild anything that settlement lost. The primary key makes a second writer on a
  market fail loudly instead of interleaving.
- **Where:** `#execute` in `exchange.ts`; `appendCommand`, `readLog` and `replay` in
  `events.ts`; migration `0009`.

### Recovery finishes what a crash interrupted, then checks the book against Postgres

- **Decision:** when a market opens, its whole log is replayed into a fresh engine. Commands
  past the settled frontier (the highest engine sequence on any of the market's orders) are
  settled. Orders still pending never reached the log and are cancelled and released. Then
  every open order in Postgres must rest on the book with the same remaining quantity, or the
  market halts.
- **Alternative:** submit the unlogged orders on boot instead of cancelling them.
- **Why:** the reply to a placed order goes out only after settlement, so the client of an
  unlogged order was never told it was accepted. Cancelling it is the answer the client
  already has, a 5xx or a dropped connection. A retry with the same client order id returns
  the cancelled order, and a new order is unaffected. Submitting it would make an order the
  client thinks failed trade minutes later. A market buy's release needs its protection
  price, so `orders.protection_price` records it (migration `0010`).
- **Where:** `recovery.ts`; `#replay` in `exchange.ts`.

### Trades are unique on (market, engine_sequence) again

- **Decision:** restored the constraint dropped in `0007`, now that sequences continue from
  the log across restarts.
- **Alternative:** rely on the frontier rule alone.
- **Why:** if the frontier rule were ever wrong, a second settlement of a command would move
  funds twice whenever the users had other orders keeping enough reserved. With the
  constraint, it fails on the trade insert and the whole settlement rolls back. A test does
  exactly that and gets Postgres error 23505 with every balance unchanged.
- **Where:** `trades` in `schema.ts`; migration `0011`.

### Tests run in their own database, with a market per exchange

- **Decision:** the suite runs on `slipstream_test`, derived from `DATABASE_URL` and migrated by
  Vitest's global setup. Every `Exchange` a test creates trades a market of its own, copied
  from BTC-USD's or ETH-USD's grid.
- **Alternative:** clone a database per test file from a template.
- **Why:** with unique sequences, a market has one writer per database, and about 45 test
  exchanges traded BTC-USD in parallel. Per-file databases would still leave several exchanges
  per file on one market, and would need a test-only way to start an engine. Per-exchange
  markets keep the production code path: every exchange replays its market's log on open.
- **Where:** `testdb.ts`, `vitest.config.ts`, `testMarket` in `testing.ts`.

### Interview note: Session 10, durability and recovery

The problem was that the order books lived only in memory, so a crash lost every resting order
and could leave a command half done: reserved but never matched, or matched but never
settled. Every engine command is now written to a Postgres event log before the engine
applies it. On boot each market replays its log into a fresh, deterministic engine, settles
whatever the crash interrupted, cancels the orders that never reached the log, and refuses to
open if the rebuilt book disagrees with the open orders in Postgres. The trade-off is one more
write per command, inside the market's single-writer queue, and a boot that replays the whole
log, because snapshots were cut. In the kill test the process is SIGKILLed after about 300
commands with one settlement blocked mid-flight and up to four orders unlogged; the log up to
the last command it reported replays to exactly the book it printed, the restart settles the
one interrupted command and cancels the unlogged orders, and the ledger sums to zero with
every reservation matching an open order.

## Measurement

### Metrics carry market and outcome labels, never ids

- **Decision:** `/metrics` labels its series by market and outcome only. An order refused before
  its market is looked up (rate limited, malformed, unlisted market) counts under
  `market="none"`, never under the market string the client sent.
- **Alternative:** label by user, to see who is busy, or take the market label from the body.
- **Why:** every distinct label set is its own series in Prometheus, held in memory and
  scraped every 5 s. A user or order id label adds a series per user or per order and grows
  without bound; a market label taken from client input lets anyone create series by sending
  made-up names. Per-user activity belongs in logs and Postgres, which are built for it.
- **Where:** `metrics.ts`; the outcome per return path in `POST /orders` in `trading.ts`.

### Two kinds of number, never mixed

- **Decision:** every figure is labelled engine-only or end to end. Engine-only is
  `npm run bench`: the engine in one process, no I/O. End to end is k6 through HTTP, the
  reservation, the event log, the settlement and Redis, against a `slipstream_bench` database
  created for the runs and dropped afterwards, with the bots stopped.
- **Machine and date:** this MacBook (Apple M4, 10 cores, 16 GB, Node 24.21.0), Postgres 16 and
  Redis 7 in Docker Desktop (10 CPUs, 7.75 GB), k6 1.2.3 in Docker reaching the API through
  `host.docker.internal`, the API at its default `LOG_LEVEL=info`. 7 November 2026.
- **Engine-only:** mixed book near 5,000 resting orders, 4,305,856 commands/s, p50 0.21 µs,
  p99 0.54 µs. One level near 10,000 orders, 2,258,113 commands/s, cancels p99 1.54 µs.
- **End to end:** one market saturates near 264 commands/s; both markets together near 320 to 340. Below that, at 200 orders and cancels a second across both markets for 3 minutes, a
  placement took p50 12.8 ms, p95 150 ms and p99 711 ms, and the match inside it p50 4.1 µs.
  Details in the next two entries.
- **Load setup:** 300 users, so even 400 orders/s is 1.3 a second per user against the limit
  of 20. No run had a 429 (rule: they are counted apart, the limit is not raised). No run had a
  503 either: k6's cap of 2,000 virtual users bounded in-flight orders below the queue's cap of
  10,000.
- **Where:** `load/orders.js`, `load/sockets.js`, `load/benchdb.ts`, `engine.bench.ts`.

### A market's ceiling is its queue's turn, and the turn is Postgres round trips

- **Finding:** each market runs one command at a time, so its ceiling is one over the mean
  turn: the log append, the match and the settlement. Ramping BTC-USD alone from 0 to 400 a
  second, the median wait in the queue stayed under 4 ms up to 252 commands/s, then jumped to
  678 ms at 264/s and grew to 7.5 s as k6 kept sending. The mean turn was 3.8 ms (p50 2.2 ms,
  p99 24 ms), which predicts 263/s. The match was 3.8 µs of it at p50.
- **What it is not:** the API's CPU was under 1.2 cores and a CPU profile at the ceiling showed
  the main thread idle 55% of the time. Postgres had 4 to 8 of the pool's 10 connections idle.
  Turning `synchronous_commit` off on the bench database moved the two-market peak only from
  about 338 to 371 commands/s, so commit fsyncs are not the limit either.
- **What it is:** a resting order sends 16 statements to Postgres over its whole life and a
  crossing order 43, measured by counting queries; a bare round trip takes 0.167 ms p50. The
  turn waits on each of its statements in sequence. Two markets share the event loop and
  Postgres, so each one's turn rose to 5.8 ms and the pair reached about 330/s, not 2 × 264.
- **Past the ceiling:** latency is Little's law. In the first ramp, which jumped straight past
  the ceiling, 2,000 orders were in flight at about 233/s, which predicts 8.6 s; the median
  placement took 8.35 s. Throughput also fell back to about 210/s once the queue was
  full, and that run did not show why.
- **The lever, not pulled:** fewer round trips per turn, by taking several queued commands per
  turn and logging and settling them in one transaction. That changes what a turn is and how
  recovery reads the frontier, so it is future work, not a measurement-session change.
- **Where:** `#execute` in `exchange.ts`; `settle` in `settlement.ts`.

### Market data fan-out shares the event loop with the queues

- **Finding:** 200 subscribers on BTC-USD's trades and book, with orders at 100/s across both
  markets, received 9,945 book deltas and 5,599 trades a second between them with no sequence
  gap in 1,791,445 deltas. A trade reached a subscriber p50 18 ms, p95 44 ms and p99 69 ms
  after settlement. Placements in that run took p50 13.9 ms and p99 218 ms.
- **At 220/s with the same 200 subscribers** the process sent about 25,000 messages a second,
  event-loop lag p99 reached 89 ms, the mean turn was 10.7 ms against 5.2 ms at 200/s without
  subscribers, and throughput fell to 177/s. Still no gap: the snapshot-and-delta protocol held while everything slowed.
- **Caveat:** the delay compares k6's container clock with the API's host clock. The smallest
  measured delay was −12 ms, so they disagree by at least that much.
- **What it means:** the engine, its settlements and the socket fan-out are one process on one
  event loop. Moving fan-out to its own process, which Redis pub/sub already allows, would
  stop subscribers slowing matching.
- **Where:** `MarketDataHub.publish` and `Connection.sendText` in `ws.ts`.

### Boot replays the whole log: 0.3 s at 118k commands, 3 s at 1M

- **Finding:** snapshots were cut, so every boot reads and replays each market's whole log
  before the API listens. Measured on a log filled through the API, three boots each, the
  markets opening in parallel:

  | Logged commands | Books rebuilt | Launch to healthy | Peak RSS   | Resting orders |
  | --------------- | ------------- | ----------------- | ---------- | -------------- |
  | 118,271         | 310 to 320 ms | 761 to 1,119 ms   | 418–449 MB | 6,529          |
  | 1,011,453       | 2.9 to 3.6 s  | 3.3 to 4.1 s      | 1.5–1.6 GB | 59,734         |

- **Where the time goes at 1M,** per market of about 500,000 commands: reading and decoding
  the log 1.4 to 1.7 s, the replay itself 0.2 to 0.5 s, the recovery check 0.2 to 0.4 s. The
  engine is the cheap part; the read is Postgres and zod.
- **Memory:** the whole log and every replayed event are in memory at once, which is the 1.5
  GB. Reading the log in pages would cap it; a snapshot would cap both time and memory.
- **The cost of cutting snapshots** is therefore about 3.5 s of downtime per million commands
  on this machine, growing in step with the log, plus that memory.
- **Where:** `#replay` in `exchange.ts`; `readLog` and `replay` in `events.ts`.

### The recovery check uses a set of resting ids

- **Decision:** checking that every order Postgres calls open is on the rebuilt book now looks
  it up in a set of resting ids.
- **Alternative:** the scan it replaced, `resting.some` for each open order.
- **Why:** the scan was open × resting comparisons. At 1M commands, with about 31,000 orders
  resting per market, it was 2.8 to 3.6 s of each market's boot and took launch to healthy to
  9.3 to 10.9 s. With the set the check takes 0.2 to 0.4 s and launch to healthy 3.3 to 4.1 s.
  The kill test never saw it, with tens of orders resting.
- **Where:** `checkBook` in `recovery.ts`.

### A balance is summed from its whole history, so every order slows as history grows

- **Finding:** filling the log to 1M commands in ten-minute chunks at a fixed offered rate,
  throughput fell chunk by chunk: about 250, 207, 185, 151, 139, 142 and 123 commands/s. The mean
  turn rose from 8 ms to 14 ms while the API's CPU fell and the match stayed under 10 µs.
  A reservation and a settlement each sum every entry of the accounts they debit, under the
  accounts' row locks. By then a user account had 2,047 entries on average and 3,902 at most,
  and summing three busy accounts took 39 to 58 ms with the load running.
- **Built on 7 November:** a cached balance per ledger account, updated in the same
  transaction as each entry under the account's lock. See the next entry for before and after.
- **Where:** `postTransaction` in `ledger.ts`.

### The cached balance, before and after, on a ledger of 3.6M entries

- **Setup:** `slipstream_bench` with k6's 300 users registered and funded through the API, then
  padded in SQL with 1,000 reserve and release pairs per user per asset: 3,601,804 entries,
  about 2,000 on every user account, interleaved across accounts the way a real history is. The
  first padding wrote each account's entries next to each other on disk, and a sum then read a
  few pages. That understated the cost, so it was rebuilt. Interleaved, summing three accounts
  took 60 ms cold. The padded database was kept as a template, and every run below started from
  a fresh copy of it. The after runs first applied the new migration, whose backfill took
  0.63–0.76 s including Node's start. Apple M4, Postgres and Redis in Docker Desktop, 7 Nov.
- **Steady 200 orders/s across both markets for 3 minutes, one run each:**

  | Build  | Placement p50 | p95    | p99    | Mean turn | Mean queue wait | Dropped |
  | ------ | ------------- | ------ | ------ | --------- | --------------- | ------- |
  | Before | 28.9 ms       | 571 ms | 1.23 s | 7.3 ms    | 90 ms           | 53      |
  | After  | 7.5 ms        | 24 ms  | 57 ms  | 3.5 ms    | 1.7 ms          | 0       |

- **Ramp to 600/s across both markets, two runs each,** settled commands a second from
  Prometheus (30 s rate):

  | Build  | Peak       | Median of the last 80 s, saturated | Mean turn  |
  | ------ | ---------- | ---------------------------------- | ---------- |
  | Before | 240–245 /s | 179–212 /s                         | 8.2–9.1 ms |
  | After  | 325–360 /s | 269–300 /s                         | 5.1–5.6 ms |

- **What it does not separate:** the change also merged the account lookup into the locking
  statement, so a posting sends one statement fewer. These runs measure the two together. The
  after numbers also beat Day 15's steady run on a nearly empty ledger (p50 12.8 ms, p99 711
  ms), where summing was cheap. So something besides the cache accounts for part of the gain:
  the dropped statement, or a difference between the runs.
- **Where:** `postTransaction` in `ledger.ts`. The runs used `load/orders.js` with
  `PROFILE=steady RATE=200 DURATION=3m` and with `PROFILE=ramp PEAK=600`, both with
  `MARKETS=BTC-USD,ETH-USD`.

### Two processes on one database: refused, not prevented

- **Finding:** a restart during the measurements started the new API while the old one was
  still draining about 2,000 queued orders in its 10 s shutdown. Both wrote the same markets.
  Recovery in the new process found pending orders changing under it, and the log's unique
  (market, sequence) would have refused a second writer's command, so it halted both markets
  instead of trading on a book it could not trust. A clean restart opened them with the ledger
  summing to zero.
- **Gap:** nothing stops a second process starting. A Postgres advisory lock per market, taken
  when the market opens and held for the process's life, would make the second process wait
  or refuse to open it.
- **Where:** `#open` in `exchange.ts`.

### Interview note: Session 11, measuring it

The problem was that the engine benchmark said 4.3 million commands a second and nothing said
what the exchange as a whole could do, or where the gap went. I added Prometheus metrics
labelled by market and outcome only, timed each command's wait, turn and match separately, and
load-tested end to end with k6 at an open-model arrival rate against a throwaway database. The
trade-off of the design shows up directly: one serial writer per market keeps the book and
the ledger consistent without locks between commands, so a market's ceiling is one over its
turn, about 264 commands/s here, because the 4 µs match sits inside a chain of 16 to 43
Postgres round trips. The same runs found three things to fix rather than defend: a quadratic
recovery check (boot at 1M commands went from 10 s to 3.4 s once it used a set), balances
summed from their whole history (throughput fell from 250 to 123 commands/s as it grew), and
no guard against two processes writing one database. Each number names its machine, date and
kind, and the ones that predict each other agree: a 3.8 ms mean turn predicts 263/s and the
measured ceiling was 264.
