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
- **Where:** `ledgerAccounts` and `ledgerEntries` in `schema.ts`; `deleteLedgerHistory` in
  `testing.ts`.

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
