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

### A balance is always summed from the entries

- **Decision:** there is no balance column. `balancesOf` and the overdraft check both `SUM` an
  account's ledger entries when they need the number.
- **Alternative:** a cached balance column updated in the same transaction as each entry.
- **Why:** with no second copy of the number, it cannot drift from the entries. The cost is a
  sum over every entry on each read. That is fine at this size; if the benchmark later shows it
  matters, a cached column comes as a proposal with numbers.
- **Where:** `balancesOf` and `postTransaction` in `ledger.ts`.

### Lock only the user accounts a transaction debits, in id order, with FOR NO KEY UPDATE

- **Decision:** `postTransaction` takes `SELECT ... FOR NO KEY UPDATE` on each user account whose
  net change is negative, sorted by id, then re-sums those accounts and refuses to overdraw them.
- **Alternative:** lock every account in the transaction, lock in posting order, or use
  `FOR UPDATE`.
- **Why:** an account that only gains money cannot be overdrawn, and the system account may go
  negative, so locking either would just queue writers: every deposit of an asset would wait on
  one system row. Sorting by id means two transactions that debit the same accounts always
  request the locks in the same order, so they queue instead of deadlocking. The lock strength
  matters too. Inserting an entry makes Postgres take `FOR KEY SHARE` on the referenced account
  for the foreign-key check, and `FOR UPDATE` blocks that. A reserve (locks available, inserts
  into reserved) and a release (locks reserved, inserts into available) on the same user and
  asset then wait on each other: 36 of 40 interleaved reserves and releases died with 40P01.
  `FOR NO KEY UPDATE` does not block `FOR KEY SHARE` but still blocks itself, so two debits of one
  account still queue. After the switch, 0 of 40 failed, and 50 parallel reservations of 10
  against 100 still give exactly 10 successes. With the lock removed, 12 got through.
- **Where:** the `debited` block in `postTransaction`, `ledger.ts`; tests under
  `concurrent reservations` in `ledger.test.ts`.

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

### A settlement locks every account it debits up front, in id order

- **Decision:** before posting any fill, `settle` collects every account the command debits
  (sellers' base reserved, buyers' quote reserved, released remainders) and locks them all at
  once with `lockAccounts`, sorted by id.
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
