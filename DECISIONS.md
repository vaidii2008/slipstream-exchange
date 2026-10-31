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
