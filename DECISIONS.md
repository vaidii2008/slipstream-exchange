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
