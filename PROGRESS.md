# Slipstream — Progress Log

## Day 1 — The repo is alive and answers a request

**Commits landed (7)**

- `chore: initialize repository with readme, license and gitignore`
- `chore: add package.json, typescript and strict tsconfig`
- `feat(api): add fastify server with a health route`
- `chore: pin typescript to 5.x for lint toolchain compatibility`
- `chore: add eslint and prettier with npm scripts`
- `chore: add env example`
- `docs: start PROGRESS.md`

**What now works**

- Fastify server in `server.ts` at the repo root, started with
  `node --experimental-strip-types server.ts`, listening on `PORT` (default 3000).
- `GET /health` returns `{"status":"ok"}` with HTTP 200.
- `buildServer()` is exported separately from the listen call, so tests can
  drive the app in memory without binding a port.
- TypeScript 5.9.3 with `strict` plus `noUncheckedIndexedAccess`, ESM via
  `"type": "module"`, target ES2022 for `bigint` literals.
- `npm run typecheck`, `npm run lint`, `npm run format` all green.
- ESLint 10 flat config with type-aware rules on `.ts`, including
  `no-floating-promises` and `no-explicit-any` as errors.
- `.env` is gitignored and verified invisible to git; `.env.example` documents `PORT`.

**What is stubbed**

- `/health` reports a hardcoded `ok`. It checks nothing. Day 2 makes it report
  real Postgres and Redis connectivity.
- No `.env` is read at runtime. Nothing parses environment variables yet;
  `server.ts` reads `process.env.PORT` directly with a fallback.
- No tests exist. No test runner is installed.
- No database, no cache, no Docker.
- Fastify's logger is disabled. Day 5 wires up pino with request logging.

**Decisions and deviations from the plan**

- `.gitignore` moved from day 1 commit 5 into commit 1, so it exists before
  `npm install` creates `node_modules/`. With no squashing allowed, one stray
  `git add .` would put dependencies into permanent history.
- TypeScript pinned to 5.x. npm installed 7.0.2 by default, and
  `typescript-eslint` requires `>=4.8.4 <6.1.0` because it calls into the
  compiler's internal APIs for type-aware linting. Chose the older compiler over
  losing the linter. Revisit when `typescript-eslint` supports TS 7.
- Pushing over HTTPS rather than SSH, matching the existing setup on this machine.
- Day 1 ran to 7 commits rather than 6 because of the TypeScript pin.

**Repo shape**

Flat. No `src/`, no folders. Seven files at the root plus `node_modules/`.

**Next: Day 2 — Postgres and Redis running locally**

- `chore: add docker compose with postgres and redis`
- `feat: add zod-validated environment config loader`
- `feat: connect to postgres on boot and fail fast on error`
- `feat: connect to redis and report both services in health`
- `test: add vitest and cover config parsing failures`

## Day 2 — Postgres and Redis running locally

**Commits landed (7)**

- `chore: add docker compose with postgres and redis`
- `feat(config): add zod-validated environment config loader`
- `test(config): cover config parsing failures with vitest`
- `feat(db): fail fast at boot when postgres is unreachable`
- `feat(redis): fail fast at boot when redis is unreachable`
- `feat(api): report postgres and redis status in health`
- `docs: record day 2 in PROGRESS.md`

**What now works**

- `compose.yaml` runs postgres:16-alpine on host port 5433 and redis:7-alpine on
  6380, both published to 127.0.0.1 only, both healthchecked, so
  `docker compose up -d --wait` blocks until they actually accept connections.
- Postgres data lives on the named volume `slipstream_postgres-data` and survives
  `docker compose down`. Redis runs with `--save ""`, holding nothing that
  matters.
- `config.ts` exports `parseConfig(env)`: a pure function that validates PORT
  (1-65535, default 3000), DATABASE_URL (postgres:// with a host) and REDIS_URL
  (redis:// or rediss:// with a host), strips undeclared keys, freezes the
  result, and throws a readable list of every problem at once.
- `npm start` runs `node --env-file-if-exists=.env server.ts`. Values in `.env`
  are local defaults; real environment variables override them.
- Boot sequence: parse config, create the pg Pool and run `select 1`, connect
  node-redis and PING, then listen. Any failure prints one line and exits 1.
- `GET /health` probes both dependencies on every request with a one-second
  timeout each, returning 200 with `{"status":"ok","checks":{...}}` or 503 with
  `"degraded"` and the dependency that is down.
- Redis recovers on its own at runtime: stopping the container flips health to
  503, starting it returns 200, with no API restart.
- Vitest runs 17 tests over the config parser. The pre-commit gate is
  `format:check`, `lint`, `typecheck`, `test`.
- tsconfig sets `allowImportingTsExtensions` with `noEmit`: Node 24 runs the
  `.ts` files directly and tsc only typechecks.

**What is stubbed**

- Nothing reads or writes data yet. The pool and the Redis client exist only for
  the boot check and `/health`. No tables, no migrations, no queries.
- No graceful shutdown. Ctrl+C ends the process without closing the pool or the
  Redis connection.
- No test for the health route. Importing `server.ts` executes the boot block,
  so a test cannot import `buildServer` without connecting to Postgres.
- `/health` is unauthenticated and uncached, so any caller can make the API run
  two probes.
- Still `console.log` and `console.error`. Day 5 brings pino.
- The gate runs on this machine only. Day 7 adds CI.

**Decisions and deviations from the plan**

- Host ports are 5433 and 6380, not the defaults, because the DocQA project's
  containers already hold 5432 and 6379. Only the host side moved; inside Docker
  the services still listen on 5432 and 6379.
- The plan's `connect to redis and report both services in health` was split in
  two. Connecting and reporting are separate reasons to change.
- The vitest commit moved ahead of the two connection commits, so those landed
  against a real suite. Vitest arrived with its first test because `vitest run`
  with no test files exits 1.
- Drivers: `pg` for Postgres (widest use, and Drizzle's node-postgres driver on
  Day 3), node-redis for Redis (ioredis's own README now recommends node-redis
  for new projects).
- Redis failure means different things at different times: fatal before the
  first successful connection, retried forever after it. One `reconnectStrategy`
  with a `hasConnected` flag expresses both.
- tsconfig lost `outDir`, `rootDir`, `sourceMap` and `declaration`. With
  `noEmit` they described output that will never exist.
- Correction to Day 1: the claim that `buildServer()` being separate from the
  listen call makes the app importable in tests was wrong. The listen block is
  top-level code in `server.ts` and runs on import.
- The `fsevents` install script is left unapproved under npm 11's allowScripts.
  `vitest run` watches nothing, so the native file watcher is not needed.

**Repo shape**

Still flat, no folders. Root holds `compose.yaml`, `config.ts`, `config.test.ts`
and `server.ts` (110 lines) alongside Day 1's files. `server.ts` now does three
unrelated jobs: defines the HTTP app, wires up dependencies, and boots the
process.

**Next: Day 3 — Users exist**

Opens with the split that Day 2 made unavoidable, then the planned commits:

- `refactor(api): move process boot out of server.ts`
- `chore: add drizzle-orm and drizzle-kit`
- `feat: define users table schema`
- `chore: generate and apply the first migration`
- `feat: add register endpoint with zod request validation`
- `feat: hash passwords with argon2id`
- `test: cover duplicate email rejection`

## Day 3 — Users exist

**Commits landed (11)**

- `refactor(api): move process boot out of server.ts`
- `style(api): apply prettier to the boot refactor`
- `chore(db): add the drizzle toolchain`
- `feat(db): define the users table schema`
- `chore(db): generate the first migration`
- `feat(auth): hash passwords with argon2id`
- `feat(api): add register endpoint with zod request validation`
- `style(api): apply prettier to the register endpoint`
- `fix(api): detect unique violations through the drizzle error cause`
- `test(api): cover duplicate email rejection`
- `docs: record day 3 in PROGRESS.md`

**What now works**

- `server.ts` exports `buildServer({ pool, redis, db })` and nothing else runs on
  import. `main.ts` is the composition root: parse config, open the pool, verify
  Postgres, open Redis, verify, wrap the pool in Drizzle, build the app, listen.
  `npm start` runs `main.ts`.
- `buildServer` declares the narrowest types it uses: something with `query`,
  something with `ping`. A test satisfies Redis with a two-line object while the
  real client still passes. `db` is the concrete `NodePgDatabase`, because a
  structural type for the query builder would be unusable.
- drizzle-orm 0.45.3 and drizzle-kit 0.31.11. `schema.ts` is the source of truth
  for the `users` table: uuid primary key defaulting to `gen_random_uuid()`,
  `email` text not null unique, `password_hash` text not null, `created_at`
  timestamptz not null defaulting to `now()`.
- `drizzle.config.ts` reads `.env` through `process.loadEnvFile`, since
  drizzle-kit is a separate process and never sees `--env-file-if-exists`. Real
  environment variables still win. It deliberately does not import `parseConfig`,
  which would fail a migration over a missing `REDIS_URL`.
- `drizzle/0000_create_users.sql` is generated, committed and applied. The
  `drizzle.__drizzle_migrations` table records it by hash, so a second `migrate`
  applies nothing. Verified by running it twice.
- `password.ts` wraps @node-rs/argon2 with argon2id at m=19456, t=2, p=1,
  outputLen=32. Output is a PHC string carrying the variant, version, parameters
  and salt, which is why `password_hash` is `text` and why the cost can be raised
  later with old hashes still verifying. Measured 6.9 ms per hash on this machine.
- `POST /register` validates with zod inside the handler. Email is trimmed and
  lowercased before the address is checked, so `"  Vaidhyam@Example.COM  "` and
  `"vaidhyam@example.com"` are one account. Password is 8–256 characters. A bad
  request returns 400 listing every issue at once, not just the first.
- Success returns 201 with `id`, `email` and `createdAt` from `.returning()`, so
  no follow-up SELECT, and no password material in the response.
- A duplicate returns 409 `email_already_registered`. There is no check-then-
  insert anywhere: the insert runs and the unique index arbitrates. A pre-check
  would leave a window between the check and the insert that no application code
  can close.
- `isUniqueViolation` walks the error `cause` chain up to five levels looking for
  SQLSTATE 23505, because Drizzle wraps the driver's `DatabaseError` in a
  `DrizzleQueryError` and the code lives on the inner one. Matching is on the
  SQLSTATE, never on message text.
- `server.test.ts` drives the app through `app.inject()` in memory, against real
  Postgres and a fake Redis. Four tests, including six concurrent registrations of
  one address producing exactly one 201, five 409s and one row.
- Tests isolate themselves with unique `register-test-<uuid>@slipstream.test`
  addresses and delete exactly those rows in `afterAll`, so the suite never
  destroys data being used by hand.
- 26 tests over three files. Gate unchanged: `format:check`, `lint`, `typecheck`,
  `test`.

**What is stubbed**

- Unhandled errors leak internals. During today's bug, Fastify's default handler
  echoed the failing SQL and a stored argon2 digest into a 500 body. Day 5's
  centralized error handler is now required, not cosmetic.
- No login, no tokens, no sessions. `verifyPassword` is written and tested but
  has no caller until Day 4.
- Registration is unauthenticated and unlimited, and every call burns ~7 ms of
  argon2 CPU. That is a denial-of-service lever until Day 15's rate limiting.
- Returning 409 confirms to an anonymous caller that an address is registered.
  Accepted knowingly: the alternative needs a mail system this simulator lacks.
- `npm test` now needs `docker compose up -d --wait` first. Day 7's CI will need
  a Postgres service container.
- There is no test database. The suite scopes itself by email; a test needing to
  assert over all users would break that and force a real one.
- `isUniqueViolation` matches the SQLSTATE only, not the constraint name. A second
  unique constraint on `users` would make a collision there report
  "email already registered".
- No graceful shutdown. Ctrl+C still leaves the pool and Redis connection unclosed.
- Still `console.log` and `console.error`. Day 5 brings pino.
- `npm audit` reports 4 moderate findings, all from drizzle-kit's dependency on
  the deprecated `@esbuild-kit` loaders, which pin an old esbuild.
  `npm audit --omit=dev` is 0, the advisories need esbuild's dev server running,
  and drizzle-kit never starts it. Not force-fixed: the only change `--force` can
  make is downgrading drizzle-kit to 0.18.1. Revisit when drizzle-kit ships a
  stable release without `@esbuild-kit`.
- Three esbuild install scripts and fsevents remain unapproved under allowScripts.
  `generate` and `migrate` both work without them.
- One manual row is left in the dev database: `vaidhyam@example.com` with
  password `hunter2hunter2`. Useful for Day 4's login testing.

**Decisions and deviations from the plan**

- Day 3 opened with the split Day 2 made unavoidable. `main.ts` is the one file
  allowed to reach out and create things; everything below it receives what it
  needs as arguments. This is what makes `app.inject()` possible at all.
- The plan's `chore: add drizzle-orm and drizzle-kit` became one commit. Kit reads
  orm's table objects and must match its version, so a repo with one and not the
  other is never a correct state.
- The plan's commits 5 and 6 were swapped: hashing landed before the endpoint.
  In the planned order the endpoint must either persist nothing or write a
  non-hash into `password_hash`, and neither is an honest green commit.
- `generate and apply the first migration` was renamed to `generate the first
migration`. Applying changes a database, not the repo, so it cannot be part of
  a commit.
- uuid over serial for the users primary key, because user ids are public and
  sequential integers expose volume and let anyone walk the range. Internal
  tables coming on Days 6–7 will likely take bigint identity instead; this is a
  per-table call, not a house rule.
- `text` plus normalisation at the API boundary, over the `citext` extension.
  One `.toLowerCase()` in zod solves what an extension would otherwise manage.
- No `updatedAt` on users. Nothing updates a user yet, and adding the column later
  is a small migration worth practising.
- @node-rs/argon2 over node-argon2, which needs exactly the postinstall prebuild
  step this machine's npm holds back, and over `node:crypto.argon2`, which is a
  raw KDF and would mean hand-rolling salt handling, PHC encoding and constant-
  time comparison.
- The argon2 variant is not passed explicitly. The package default is argon2id
  and it exports the variant as a const enum, which TypeScript refuses to read
  under isolatedModules. The test asserts the `$argon2id$v=19$m=19456,t=2,p=1$`
  prefix instead, which is a stronger guarantee than a setting.
- zod parsing sits inside the handler rather than in Fastify's JSON Schema option,
  so there is one description of each request shape. Day 4's login repeats the
  same four lines; that repetition is what earns a shared helper, not before.
- Two `style:` commits were needed because supplied code exceeded the print width
  twice and the gate was run after `git add` instead of before. Working rule from
  here: `npm run format` first, then the full gate, then stage and commit.
- One `fix:` commit because the first attempt checked `error.code` on the thrown
  object. A throwaway probe script showed the code one layer down in `cause`.
  Diagnosing before editing is what made that a three-line fix.
- Day 3 ran to 11 commits rather than 7.

**Repo shape**

Still flat. Root now also holds `drizzle.config.ts`, `schema.ts`, `password.ts`,
`password.test.ts` and `server.test.ts`, alongside the generated `drizzle/`
directory, which is the only directory in the repo and is excluded from Prettier
via `.prettierignore`.

`server.ts` is just over 100 lines and now holds two unrelated route groups plus
their helpers. Day 4 adds login, an auth prehandler and a current-user route. That
is the pressure that will force routes into their own module, probably mid-day.

**Next: Day 4 — Login works**

- `feat: add login endpoint with credential verification`
- `feat: issue short-lived jwt access tokens`
- `feat: add auth prehandler and current-user route`
- `fix: return a uniform error shape for auth failures`
- `test: cover login success and wrong-password paths`

## Day 4 — Login works

**Commits landed (9)**

- `feat(auth): issue short-lived jwt access tokens`
- `feat(api): add login endpoint with credential verification`
- `refactor(api): move auth out of server.ts`
- `refactor(auth): share one request validation across auth routes`
- `style(auth): apply prettier to the shared request validation`
- `feat(auth): add an authenticated current-user route`
- `test(api): cover login outcomes`
- `test(api): cover the current-user route`
- `docs: record day 4 in PROGRESS.md`

**What now works**

- `tokens.ts` exports `createAccessTokens(secret, { ttlSeconds, now })` on jose 6.
  HS256 is pinned on verify, so a token whose header claims `alg: none` is
  rejected; a test proves it. Tokens carry only `sub`, `iat`, `exp`, `iss` and
  `aud`, live 15 minutes, and need a secret of at least 32 bytes.
- `verify` returns `{ ok: true, userId, expiresAt }` or
  `{ ok: false, reason: "expired" | "invalid" }` instead of throwing. Only
  jose's own errors become `invalid`; anything else is rethrown as a bug. The
  clock is injected, so expiry is tested at the exact second, without sleeping.
- `JWT_ACCESS_SECRET` is required config, at least 32 characters, and a failed
  check never echoes the value. `.env.example` ships `change-me`, which
  deliberately fails validation, so nobody boots with a secret published on
  GitHub. The local secret is 64 characters from `openssl rand -base64 48`.
- `POST /login` returns 200 with `{ accessToken, tokenType: "Bearer" }`. An
  unknown email and a wrong password get byte-identical 401
  `invalid_credentials` responses, and the unknown-email path verifies against
  a dummy argon2 hash so both cost one verify. Measured over 30 requests each:
  medians 10.3 ms and 9.4 ms, p90 13.1 ms and 10.4 ms. Without the dummy verify
  the gap would be about 7 ms.
- Login validates the password as `min(1)`, not register's `min(8)`, so a
  future policy change never locks existing users out with a 400.
- `auth.ts` owns register, login and `/me`. `server.ts` is 55 lines: it builds
  the app, owns `/health`, and calls `registerAuthRoutes`.
  `ServerDependencies` is `AuthDependencies` plus the two probes.
- One `emailField` schema serves register and login, so the two can never
  normalise an address differently. `invalidRequest` builds every 400 body. A
  characterisation test confirmed the refactor kept both 400 responses
  byte-identical, at 173 bytes each.
- `GET /me` is protected by an `authenticate` hook at `onRequest`, so an
  unauthenticated request is rejected before its body is parsed. The
  `Bearer` scheme is matched case-insensitively. Failures are 401
  `missing_token`, `invalid_token` or `token_expired`, each with a
  `WWW-Authenticate` header. `request.userId` is declared on every request,
  starting as `null`, through `decorateRequest` plus declaration merging.
- `/me` reloads the user row, so a still-valid token for a deleted user is
  refused. If the hook is ever removed from the route, the handler throws and
  every call is a loud 500, never a silent pass.
- 47 tests over four files: tokens 8, config 19, password 5, server 15. Two
  were watched failing on purpose: renaming the unknown-email error to
  `user_not_found` failed the identical-response test, and removing the hook
  from `/me` failed all six route tests with a 500.

**What is stubbed**

- No refresh tokens, no logout, no revocation. A leaked access token works for
  its full 15 minutes. Day 5 adds the rotating refresh token.
- Fastify's default error bodies are still live. Unknown routes return
  `{ message, error, statusCode }` instead of our `{ error }` shape, and
  unhandled errors still leak internals into 500 bodies. Day 5's centralized
  error handler fixes both.
- Login is unlimited, so password guessing is bounded only by argon2's cost
  until Day 15's rate limiting.
- The login 401 carries no `WWW-Authenticate` header. Credentials travel in the
  body, not in an HTTP auth scheme, so there is no meaningful challenge to send.
  Accepted knowingly.
- Timing equality is checked by hand, not in the suite: too noisy for an
  assertion that must pass every run. The first unknown-email login after boot
  also pays one extra hash to create the dummy.
- `authenticate` and `invalidRequest` are private to `auth.ts`. Day 15's order
  endpoint is the second consumer that will move them out.
- No `jti` claim, so individual access tokens cannot be revoked. Refresh-token
  revocation on Day 5 is the intended answer, not a deny-list.
- Carried over: no graceful shutdown, still `console.log`, no test database,
  `npm audit` dev-only findings from drizzle-kit, and the manual
  `vaidhyam@example.com` row with password `hunter2hunter2`.

**Decisions and deviations from the plan**

- Token issuing landed before the login endpoint, for the same reason hashing
  preceded register on Day 3: a login with nothing to return is not an honest
  green commit.
- jose over `@fastify/jwt`, so tokens are plain functions testable without an
  app instance. HS256 over an asymmetric algorithm, because one process both
  signs and verifies.
- `onRequest` over the plan's `preHandler`: rejecting before body parsing is
  cheaper and avoids parsing bodies about to be thrown away.
- The plan's `add auth prehandler and current-user route` was renamed to one
  change, because a hook with no route is unverifiable. The plan's one test
  commit became two: login and `/me` are separate subjects.
- The plan's `fix: return a uniform error shape for auth failures` was dropped.
  Every auth failure already had one shape; the only inconsistent bodies are
  Fastify's defaults, which belong to Day 5. A pre-planned `fix:` means
  inventing something to fix.
- The `move auth routes` commit was amended once, for a missing word, and
  pushed with `--force-with-lease`: the tip of a solo repo, caught within
  minutes. Every later problem was fixed forward instead.
- `fb12f0b` was pushed without `npm run format` and is red on `format:check`;
  the `style:` commit after it fixes that. The rule stands: format, full gate,
  `git add`, commit, push, in that order, every time.
- Working lessons: Oh My Zsh's `url-quote-magic` escapes `;` after a URL, so
  use `curl -w "\n"` instead of `; echo`. Vitest strips types without checking
  them, so typos crash at runtime and only `tsc` catches them early. Check
  `lsof -nP -iTCP:3000 -sTCP:LISTEN` before trusting a manual result. Patches
  now label anchor lines `(already there)`, and files under about 200 lines get
  full replacements.
- Day 4 ran to 9 commits rather than 5.

**Repo shape**

Still flat. New at the root: `tokens.ts`, `tokens.test.ts` and `auth.ts`.
`server.ts` dropped to 55 lines; `auth.ts` is about 180. Day 5's refresh and
logout routes will push `auth.ts` past 200 lines and give it a second reason
to change, session lifecycle as well as credential checks. Expect that split
early on Day 5.

**Next: Day 5 — Sessions survive a refresh**

- `feat: add refresh tokens table and migration`
- `feat: rotate refresh tokens on the refresh endpoint`
- `feat: add logout with token revocation`
- `feat: add centralized error handler and pino request logging`, likely split
  in two, since an error handler and request logging are separate reasons to
  change
- `test: cover refresh rotation and token reuse detection`

## Day 5 — Sessions survive a refresh

**Commits landed (16)**

Pushed before today's session, recorded here for the first time:

- `feat(db): define the refresh tokens table schema`
- `docs: restore days 1 to 3 in PROGRESS.md`
- `chore(db): generate the refresh tokens migration`
- `feat(auth): issue a refresh token at login`
- `chore(deps): bump fastify for GHSA-4mh8-r7rc-xpvc`
- `refactor(auth): move session handling out of auth.ts`
- `feat(auth): rotate refresh tokens on the refresh endpoint`
- `feat(auth): revoke the token family when a refresh token is reused`
- `feat(auth): add logout with token revocation`

Today:

- `test(auth): cover refresh rotation and reuse detection`
- `feat(api): log requests with pino instead of console.log`
- `feat(api): return one error shape from a central error handler`
- `feat(api): shut down gracefully on SIGTERM and SIGINT`
- `chore: add a check script that runs the whole gate`
- `ci: run the gate on every push with Postgres and Redis services`
- `docs: start DECISIONS.md with the auth and API decisions`

**What now works**

- Login sets a `slipstream_refresh` cookie: httpOnly, secure, `SameSite=Strict`,
  scoped to `/session`, seven days. Only its SHA-256 hash is stored, in
  `refresh_tokens`, together with a `family_id` that every rotation inherits.
- `POST /session/refresh` consumes the token with one
  `UPDATE ... WHERE used_at IS NULL AND revoked_at IS NULL AND expires_at > now`
  and inserts its successor in the same transaction. A used token presented
  again revokes the whole family. An expired or unknown token is a plain 401.
- Two concurrent refreshes with the same token: the row lock makes the second
  `UPDATE` wait, re-check, find `used_at` set and treat itself as a replay. One
  gets 200, the family ends revoked. Ran the test eight times in a row with no
  flake.
- `POST /session/logout` revokes the presented token's family, even when that
  token is an older rotated one, clears the cookie, and answers 204 with or
  without a cookie.
- `sessions.test.ts` holds 11 tests for all of the above, against real Postgres.
- Fastify logs through its built-in pino at `LOG_LEVEL` (default `info`): one
  JSON line per request in and out, tied by a UUID request id. Pool and Redis
  errors and startup go through the same logger. Tests leave logging off.
- One error shape: every error body has an `error` code. Fastify's 4xx errors
  also return their message (malformed JSON is 400 `invalid_request`, a wrong
  content type is 415 `unsupported_media_type`). Anything else is a bare 500
  `internal_error`, with the detail logged under the request id. Unknown routes
  are 404 `not_found`. This closes the Day 3 leak of SQL and an argon2 digest in
  a 500 body.
- SIGTERM or SIGINT closes Fastify, waits for in-flight requests, then closes
  Redis and the pool in an `onClose` hook, and exits 0. A 10 second timer forces
  exit 1. Checked by hand: a login in flight at SIGTERM still returned 401
  (31 ms) between "shutting down" and "shutdown complete".
- `npm run check` runs format:check, typecheck, lint and test, stopping at the
  first failure.
- GitHub Actions runs on every push and pull request: Postgres 16 and Redis 7
  service containers, `npm ci`, `drizzle-kit migrate` on the empty database,
  then `npm run check`. Rehearsed locally against a fresh `ci_rehearsal`
  database: both migrations applied, 68/68 passed, database dropped after.
- 68 tests in 5 files, up from 51.

**What is stubbed**

- The CI workflow has not run on GitHub yet; it first runs on the next push.
- Graceful shutdown has no automated test: it lives in `main.ts`, which runs
  on import. The manual check above is the evidence.
- No `pino-pretty`: local logs are raw JSON.
- Carried over: no test database separate from the dev one, `npm audit`
  dev-only findings from drizzle-kit, and the manual `vaidhyam@example.com`
  row.

**Decisions and deviations from the plan**

- Logout had already landed and already revokes the family, so the plan's
  first commit was done before the session started.
- Logging landed before the error handler, swapping the planned order: with
  Fastify's logger off, the handler's 500 logs would have gone nowhere.
- Logout tests went into the refresh test commit; there were none before.
- `LOG_LEVEL` is new config, validated as one of pino's levels, in
  `.env.example` and optional in `.env`.
- `DECISIONS.md` is new, with five entries. The concurrent-refresh behaviour
  is the one to defend: strict reuse detection over a grace window.

**Repo shape**

Still flat. New: `sessions.test.ts`, `DECISIONS.md` and
`.github/workflows/ci.yml`, a path GitHub requires. `server.test.ts` is 339
lines and is mostly auth-route tests, which is pressure to move them to
`auth.test.ts` in a `refactor:` commit. The two test files also repeat the
same Postgres and app setup; a third database test file would justify
sharing it.

**Next: Day 6 — Money and the ledger**

- `feat(money): convert decimal strings to bigint minor units at a fixed scale`
- `feat(db): define assets and markets with a seed for BTC, ETH and USD`
- `feat(db): define ledger accounts, transactions and entries`
- `feat(ledger): post a balanced transaction atomically`
- `feat(api): add a simulated deposit endpoint`
- `feat(api): report balances derived from the ledger`
- `feat(ledger): reserve and release funds under row locks`
- `test(ledger): prove parallel reservations cannot overdraw`

## Day 6 — Money and the ledger

**Commits landed (12)**

- `refactor(test): move the auth route tests from server.test.ts to auth.test.ts`
- `refactor(test): share the Postgres test setup`
- `feat(money): convert decimal strings to bigint minor units at a fixed scale`
- `feat(db): define assets and markets with a seed for BTC, ETH and USD`
- `feat(db): define ledger accounts, transactions and entries`
- `feat(ledger): post a balanced transaction atomically`
- `refactor(auth): export the bearer hook for a second consumer`
- `feat(api): add a simulated deposit endpoint`
- `feat(api): report balances derived from the ledger`
- `feat(ledger): reserve and release funds under row locks`
- `test(ledger): prove parallel reservations cannot overdraw`
- `docs: record the money and ledger decisions in DECISIONS.md`
- `docs: record day 6 in PROGRESS.md`

**What now works**

- `money.ts` is the one conversion module. `parseAmount("1.5", 8)` is `150000000n`.
  It rejects negatives, exponents, leading zeros, more decimals than the scale and
  anything past NUMERIC(36,18), and never rounds. `fromNumeric` reads Postgres's
  18-decimal text back, and `formatAmount` prints exactly the asset's scale.
- `assets` (BTC 8, ETH 8, USD 2) and `markets` (BTC-USD and ETH-USD, tick 0.01,
  minimum quantity 0.0001 and 0.001) are seeded by a custom migration, so CI and
  any fresh database get them from `drizzle-kit migrate`.
- `ledger_accounts`, `ledger_transactions` and `ledger_entries` exist. Accounts
  open on first use; the null-owner system account is one per asset through
  `UNIQUE NULLS NOT DISTINCT`. Nothing cascades.
- `postTransaction` writes a transaction and its entries atomically, and rejects
  postings that don't sum to zero per asset, zero amounts, unknown accounts, and
  any overdraft of a user account. It locks the debited user accounts in id
  order with `SELECT ... FOR UPDATE` before re-summing them.
- `reserve` and `release` move funds between available and reserved.
- `POST /deposits { asset, amount }` credits the caller from the system account.
  `GET /balances` lists every asset's available and reserved balance, summed
  from the entries.
- 50 parallel reservations of 10 against 100: exactly 10 succeed, 0 available
  and 100 reserved after. With the lock removed by hand, 12 succeeded. Passed in
  five consecutive runs of `ledger.test.ts` and three of the full suite.
- 128 tests in 9 files, up from 68.

**What is stubbed**

- Nothing calls `reserve` or `release` over HTTP yet; order placement does in
  Session 4.
- Balanced-per-asset is enforced in `postTransaction`, not by the database. Rows
  written by hand in psql are not checked.
- Carried over: no test database separate from the dev one, `npm audit` dev-only
  findings from drizzle-kit, the manual `vaidhyam@example.com` row, and the CI
  workflow has still not run on GitHub.

**Decisions and deviations from the plan**

- Two refactors came first: the auth tests moved to `auth.test.ts`, then the
  three copies of the Postgres test setup became `useTestServer()` in
  `testing.ts`. Teardown now deletes test users' whole ledger transactions
  before the users.
- `bearerAuth` left `registerAuthRoutes` in its own refactor commit, because the
  wallet routes were its second consumer.
- The deposit and balance routes live in `wallet.ts`, not `ledger.ts`: HTTP
  shape and bookkeeping rules change for different reasons.
- Only debited user accounts are locked; the system account is not, so deposits
  don't queue on one row. Four entries in `DECISIONS.md`.

**Repo shape**

Still flat. New: `money.ts`, `ledger.ts`, `wallet.ts`, `testing.ts` and their
tests. `ledger.ts` is 284 lines with three jobs: accounts, posting, and
balances/reservations. Trade settlement in Session 4 adds a fourth, so that is
the point to split it.

**Open question for Session 4**

USD has scale 2, but a BTC quantity at scale 8 times a price at a 0.01 tick is
not always a whole number of cents (0.00000001 BTC at 65000.00 is 0.00065 USD).
Settlement needs either a quote rounding rule or a quantity step per market.
A quantity step is a new column, so it comes as a proposal first. Raising the
USD scale needs no data migration, because NUMERIC stores decimals, not minor
units.

**Next: Day 7 — Matching engine**

- `feat(engine): rest limit orders in sorted price levels with FIFO queues`
- `feat(engine): match an incoming limit order by price-time priority`
- `feat(engine): fill partially and rest the remainder`
- `feat(engine): execute market orders without resting the remainder`
- `feat(engine): cancel a resting order by id`
- `feat(engine): prevent self-trades by cancelling the incoming order`
- `feat(engine): emit typed events with a per-market sequence number`
- `test(engine): check invariants over random order sequences`

## Day 7 — Matching engine

**Commits landed (11)**

- `fix(ledger): lock debited accounts FOR NO KEY UPDATE so reserve and release cannot deadlock`
- `feat(engine): rest limit orders in sorted price levels with FIFO queues`
- `feat(engine): match an incoming limit order by price-time priority`
- `refactor(engine): move the order book into book.ts`
- `feat(engine): execute market orders without resting the remainder`
- `feat(engine): cancel a resting order by id`
- `feat(engine): prevent self-trades by cancelling the incoming order`
- `feat(engine): emit typed events with a per-market sequence number`
- `test(engine): check invariants over random order sequences`
- `docs: record the matching engine decisions in DECISIONS.md`
- `docs: record day 7 in PROGRESS.md`

**What now works**

- Ledger fix: a reserve and a release on the same user and asset could deadlock.
  Each held `FOR UPDATE` on the account it debited, while its entry insert needed
  `FOR KEY SHARE` on the other account for the foreign-key check. With 40
  interleaved reserves and releases, 36 died with 40P01. With
  `FOR NO KEY UPDATE`, 0 did, and the 50-parallel overdraw test still gives
  exactly 10 successes. Passed five consecutive runs of `ledger.test.ts`.
- `OrderBook` (`book.ts`): bids and asks as price levels sorted worst-first, with
  the best level last, FIFO queues within a level, an id index, `best`,
  `fillBest`, `remove` and a copying `snapshot`.
- `Engine` (`engine.ts`), one per market: limit orders match by price-time
  priority at the maker's price and rest the remainder. Market orders sweep and
  cancel the remainder (`no_liquidity`). `cancel(id)` returns a `cancelled`
  event, or `cancel_rejected` if the order isn't resting. Self-trades stop the
  incoming order (`self_trade`) and earlier fills stand.
- Events are a typed union (`trade`, `rested`, `cancelled`, `cancel_rejected`),
  stamped with the market and a sequence number from 1 with no gaps. A command
  that throws spends no numbers.
- Property tests run 5 × 300 generated sequences (median about 90 commands,
  maximum 200): no crossed, unsorted or empty level after any step; quantity
  conserved per order; no trade beyond a limit and no self-trades; sequences
  1..n; identical events and book on replay. Four bugs injected by hand each
  failed the property meant to catch them.
- 171 tests in 12 files, up from 128.

**What is stubbed**

- The engine is not wired to anything: no queue, no orders table, no settlement.
  That is Session 4.
- `cancel` doesn't check ownership. The orders layer will check it against the
  orders table before enqueueing.
- Market buys are sized in base quantity only. Session 5's capped reservation
  will need the engine to stop at a quote budget, which means passing the base
  scale in so it can compute price × quantity.
- Carried over: no test database separate from the dev one, `npm audit` dev-only
  findings from drizzle-kit, the manual `vaidhyam@example.com` row, and the CI
  workflow has still not run on GitHub.

**Decisions and deviations from the plan**

- The ledger fix came first, as its own commit, with a failing regression test
  shown before the change.
- "Match an incoming limit order" and "fill partially and rest the remainder"
  became one commit. Every fill is the smaller of two quantities, so splitting
  them would have meant writing a stub that drops the leftover.
- Events existed from the first matching commit; the sequence-number commit
  added the stamp rather than replacing a different return type.
- fast-check's default array size caps generated sequences at 10 commands
  whatever `maxLength` says. The property tests use `size: "large"`.
- Approved for the start of Session 4, before the orders table: USD scale
  becomes 8 and `markets` gains `quantity_step` (BTC-USD 0.0001, ETH-USD 0.001).
  Prices must be multiples of the tick and quantities multiples of the step, at
  least the minimum. A test checks that tick × step is exact at the quote
  asset's scale for every market. This lands as a new migration. It answers
  Day 6's open question.
- Three entries plus the Session 3 interview note in `DECISIONS.md`, and the
  locking entry is updated for `FOR NO KEY UPDATE`.

**Repo shape**

Still flat. New: `book.ts` (the book) and `engine.ts` (matching rules), split
once `engine.ts` reached 221 lines with two reasons to change. Also
`engine.property.test.ts`, kept separate from `engine.test.ts` (about 420 lines)
because it has its own generators and runner. `ledger.ts` still needs its split
when trade settlement arrives.

**Next: Day 8 — Engine numbers, placing orders**

- `perf(engine): add a benchmark reporting orders/sec and p50/p99 match latency`
- `perf(engine): <one optimisation>`, only if the baseline shows a hotspot
- `feat(db): raise USD scale to 8 and add a quantity step per market`
- `feat(db): define orders and trades tables`
- `feat(orders): serialize each market's commands through one queue`
- `feat(orders): place a limit order with funds reserved first`
- `feat(orders): persist trades and settle both sides in the ledger`
- `test(orders): cover place, partial fill and full fill between two real users`

## Day 8 — Engine numbers, placing orders

**Commits landed (14)**

- `perf(engine): add a benchmark reporting orders/sec and p50/p99 match latency`
- `feat(db): raise USD scale to 8 and add a quantity step per market`
- `feat(db): define orders and trades tables`
- `refactor(ledger): accept an open transaction wherever a database is accepted`
- `feat(orders): reserve funds and record a limit order`
- `feat(orders): serialize each market's commands through one queue`
- `refactor(ledger): expose the debit lock so a caller can lock several postings at once`
- `fix(db): drop the unique trade sequence until engine sequences survive a restart`
- `feat(orders): match placed orders and settle trades in the ledger`
- `refactor(orders): move matching and settlement into exchange.ts`
- `feat(api): accept limit orders on POST /orders`
- `test(orders): cover place, partial fill and full fill between two real users`
- `docs: record the order placement and settlement decisions in DECISIONS.md`
- `docs: record day 8 in PROGRESS.md`

**What now works**

- `npm run bench` (`engine.bench.ts`) times 1,000,000 seeded commands against
  the engine alone. A shadow engine generates them, so cancels hit live orders
  and the book holds a steady size. On an Apple M4 with Node 24.21: mixed book
  near 5,000 orders, about 4.4M commands/s, p50 0.17 µs, p99 0.58 µs; one
  level near 10,000 orders, about 2.28M commands/s, cancels p99 1.54 to
  1.71 µs.
- USD is at scale 8 and markets have `quantity_step` (migration 0005). Every
  seeded market passes the tick × step exactness test.
- `orders` and `trades` tables (0006, then 0007 drops one constraint).
- `recordLimitOrder` (`orders.ts`) checks the tick, step and minimum, then
  reserves price × quantity of quote (buy) or the quantity of base (sell) and
  inserts the order as `pending`, all in one transaction. 12 parallel sells of
  0.25 against 1 BTC: exactly 4 recorded.
- `Exchange` (`exchange.ts`): one engine and one `SerialQueue` per market. Each
  order is matched and then settled in one transaction before the next command
  starts. A settlement does the following:
  - a trade row and a ledger transaction per fill;
  - returns the buyer's unused reservation when the fill is below their limit;
  - releases a self-trade-cancelled remainder;
  - updates filled quantity, status and engine sequence on both orders.
- `POST /orders` (`trading.ts`) places limit orders. 400 with the field for a
  bad amount or an order off the grid, 422 `insufficient_funds`, 201 with
  status, filled quantity and fills.
- Two users trade BTC-USD over HTTP through a resting sell, a partial fill,
  a completed fill with a resting remainder, and a fill at the resting bid's
  price. Balances are checked after every step; 1 BTC and 100,000 USD in,
  1 BTC and 100,000 USD out.
- 214 tests in 16 files, up from 171.

**What is stubbed**

- Market orders are rejected by the API (`type` must be `limit`). Settling a
  cancelled market order throws on purpose. Both arrive with Session 5's capped
  reservation.
- No cancel endpoint and no order listing yet (Session 5).
- If a settlement transaction fails, the engine has already applied the
  command, so the book and Postgres disagree. The order stays `pending` and
  reserved. Nothing halts the market or repairs it yet (Session 5 commit 7,
  then Session 10).
- Books live in memory. After a restart the books are empty, open orders keep
  their reservations, and sequences restart at 1. Session 10's recovery fixes
  all three and brings back the unique trade sequence.
- The per-market queue is unbounded. Session 5's rate limit is the first
  brake; Session 11's load test shows whether it needs a depth limit.
- `client_order_id` exists but the API does not accept it yet (Session 5's
  idempotency keys).
- Carried over: no test database separate from the dev one, `npm audit`
  dev-only findings from drizzle-kit, the manual `vaidhyam@example.com` row, and
  the CI workflow has still not run on GitHub.

**Decisions and deviations from the plan**

- No `perf(engine)` optimisation. The baseline showed no hotspot. Cancels on a
  10,000-deep level cost about 1.3 µs because of the `indexOf` scan, against
  milliseconds per settlement. The first benchmark version let one level grow
  to 137,000 orders and showed 180 µs cancels; that was the generator's bug.
- "Place a limit order with funds reserved first" became three commits:
  reserve and record, then match and settle, then the HTTP route. A route that
  matched without settling would have lost fills.
- Two refactors had named pressure: the ledger had to accept a transaction
  (reserve and insert must commit together), and the debit lock had to be
  callable on its own (cross-market deadlock). Then `orders.ts` reached 407
  lines with two reasons to change and split into `orders.ts` and
  `exchange.ts`.
- Not in the plan, flagged here: order statuses are `pending`, `open`,
  `filled` and `cancelled`. There are check constraints on positive amounts,
  filled ≤ quantity, and price present exactly on limit orders.
- Added and then dropped `trades` unique on (market, engine_sequence). Engines
  restart their numbering on every start, and the tests showed the collision.
- Cross-market deadlock: with the up-front lock removed, the test deadlocked
  in 5 of 5 runs; with it, 0 of 5.
- Test cleanup is now `deleteTradingHistory`: trades, then orders, then the
  ledger.

**Repo shape**

Still flat. New: `engine.bench.ts` (a script outside the test gate),
`markets.test.ts` (seeded reference data), `orders.ts` (accepting an order),
`exchange.ts` (running markets and settling, split from `orders.ts` at 407
lines) and `trading.ts` (the order routes). `trading.ts` is separate because it
needs both `orders.ts` and `exchange.ts`, and `exchange.ts` already imports
`orders.ts`.

**Next: Day 9 — Order lifecycle complete**

- `feat(orders): place market orders with a capped reservation`
- `feat(orders): cancel an order and release its remaining reservation`
- `feat(orders): list open orders, order history and my trades`
- `feat(api): serve public order book snapshots and recent trades`
- `feat(orders): accept idempotency keys on order placement`
- `feat(api): rate limit order placement per user with Redis`
- `test(orders): show a failed settlement leaves the ledger balanced`
- Interview note in `DECISIONS.md`

## Day 9 — Order lifecycle complete

**Commits landed (11)**

- `feat(orders): place market orders with a capped reservation`
- `feat(orders): cancel an order and release its remaining reservation`
- `refactor(orders): move reading orders back into history.ts`
- `feat(orders): list open orders, order history and my trades`
- `feat(api): serve public order book snapshots and recent trades`
- `feat(orders): accept idempotency keys on order placement`
- `feat(api): rate limit order placement per user with Redis`
- `feat(orders): halt a market when its settlement fails`
- `feat(orders): cap each market's queue at 10,000 pending commands`
- `docs: record the order lifecycle decisions and the session 5 interview note`
- `docs: record day 9 in PROGRESS.md`

**What now works**

- Market orders. On arrival each one gets a protection price: the best opposite price moved
  5% against the taker, on the tick grid. A buy reserves quantity × that price. The engine
  stops matching at it and cancels the rest, and settlement returns whatever was not spent.
  A market order against an empty side is refused with 422 `no_liquidity`.
- `DELETE /orders/:id` cancels through the market's queue and releases the unfilled
  quantity's reservation. 409 `order_not_open` if it already filled or was cancelled. 404 for
  another user's order, the same as for one that does not exist.
- `GET /orders?status=open|closed|all&market=&limit=` (newest first, at most 500) and
  `GET /fills` (the caller's side of each trade, maker or taker).
- Public, no token: `GET /markets/:symbol/book?depth=` (price levels with total quantity,
  plus the engine sequence) and `GET /markets/:symbol/trades?limit=` (newest first, with the
  taker's side). Neither contains a user id or an order id; tests check the response bodies.
- `clientOrderId` on `POST /orders`. A repeat returns the original order with 200 and
  reserves nothing. The same key on a different order is 409. Five identical requests at once:
  one 201, four 200s, one reservation.
- Rate limit: `ORDER_RATE_LIMIT` orders per user per second (default 20), 429 `rate_limited`
  with `Retry-After`. Fixed window on Redis. If Redis is unreachable, the order goes ahead and
  the error is logged.
- Fail-stop. A failed settlement halts its market and logs at fatal. From then on, every
  order and cancel for that market gets 503 `market_halted` until restart; other markets keep
  trading.
- Each market admits at most 10,000 unfinished commands; past that, 503 `market_busy` with
  `Retry-After: 1`. A refused order has reserved nothing.
- 276 tests in 18 files, up from 214 in 16. Tests now use a real Redis client.

**What is stubbed**

- After a halt, the order whose settlement failed stays `pending` and reserved, and so does
  any order queued behind it. Only a restart clears the halt, and after a restart the books are
  empty (Session 10).
- After a restart, an order that is `open` in Postgres is not on the book, so cancelling it
  returns 409 and its reservation stays (Session 10).
- A repeat of an order that is still queued returns it as `pending`.
- Order and fill lists take a `limit` but have no cursor for the next page.
- Only placement is rate limited, not cancels.
- While node-redis is reconnecting it queues commands, so a Redis outage can delay orders by
  up to the reconnect backoff (at most 2 s) before the limiter fails open.
- Carried over: no test database separate from the dev one, `npm audit` dev-only findings
  from drizzle-kit, the manual `vaidhyam@example.com` row, and the CI workflow has still not
  run on GitHub.

**Decisions and deviations from the plan**

- "Show a failed settlement leaves the ledger balanced" became fail-stop. The test forces a
  real failure with no test hook: it releases a seller's reserved BTC behind the exchange's
  back, so the next fill's ledger posting fails for insufficient funds.
- Added: the per-market cap of 10,000 pending commands, counted from admission rather than
  from enqueue, so nothing is reserved for a command that will be refused.
- The public book is summed inside `OrderBook.depth`, so per-order data never reaches the
  route. That is stronger than stripping `userId` from a snapshot.
- `recordOrder` now inserts the order before reserving, so the unique (user, client order id)
  index serialises repeats. Six parallel identical sells against a balance that funds one gave
  one order and one reservation.
- `POST /orders` bodies are strict: an unknown field, or a price on a market order, is 400.
- Scope: no Grafana dashboard. `/metrics` and the k6 numbers stay.

**Repo shape**

Still flat. New:

- `history.ts`: reading a user's orders and fills back. It was split from `orders.ts` at 232
  lines, which had two reasons to change.
- `market.ts`: public market data. It has a different audience from `trading.ts`, which is
  past 200 lines, and Session 6 builds on it.
- `ratelimit.ts`: the window logic needs its own test against Redis with a controlled clock.

`trading.ts` is now 351 lines, all order routes for a signed-in user. If Session 6 adds
to it, it should split by route.

**Next: Day 10 — Real-time market data**

- `feat(ws): accept connections with a zod-validated subscribe protocol`
- `feat(ws): stream an order book snapshot then sequenced deltas`
- `feat(ws): stream public trades`
- `feat(ws): stream private order and balance events on an authenticated channel`
- `feat(ws): fan out market events through Redis pub/sub`
- `feat(ws): send heartbeats and drop clients whose send buffer exceeds a cap`
- `test(ws): show a client that misses a sequence detects the gap and resyncs`
- Public channels follow the same rule as the public routes: price levels only, no user ids
  or order ids.
- Interview note in `DECISIONS.md`

## Day 10 — Real-time market data

**Commits landed (12)**

- `refactor(redis): move the Redis client factory out of main.ts`
- `fix(api): fail the order rate limit open within 100 ms when Redis is down or slow`
- `refactor(orders): move settlement out of exchange.ts into settlement.ts`
- `feat(ws): accept connections with a zod-validated subscribe protocol`
- `feat(ws): stream an order book snapshot then sequenced deltas`
- `feat(ws): stream public trades`
- `feat(ws): stream private order and balance events on an authenticated channel`
- `refactor(ws): move market data message formatting into feed.ts`
- `feat(ws): fan out market events through Redis pub/sub`
- `feat(ws): send heartbeats and drop clients whose send buffer exceeds a cap`
- `test(ws): show a client that misses a sequence detects the gap and resyncs`
- `docs: record the market data decisions and the session 6 interview note`
- `docs: record day 10 in PROGRESS.md`

**Correction to Day 9**

Day 9 said a Redis outage could delay orders "by up to the reconnect backoff (at most
2 s)". That was wrong. The 2 s is only the interval between reconnect attempts. With the
offline queue on, a command issued during an outage waited until Redis came back, however
long that took, so POST /orders hung and the waiting commands grew without bound. It is
fixed below.

**What now works**

- The rate limiter fails open quickly in both bad cases:
  - The API's Redis client has `disableOfflineQueue`.
  - The limiter refuses on its own while the client is reconnecting. node-redis 6 still
    queues a `MULTI` offline even with that option.
  - It gives up after 100 ms, which covers a connected but slow Redis.
  - Tests use a per-test TCP proxy in front of Redis that can hold replies back, cut the
    connection or come back. Before the fix both tests hung until the 5 s test timeout.
- `/ws`, one WebSocket for everything, with zod-validated JSON commands:
  - `subscribe` and `unsubscribe` for `book` and `trades` per market, and `account`.
  - `auth` with an access token. The connection closes with code 4001 when the token
    expires.
  - A bad message gets an `invalid_message` error and the connection stays open; anything
    over 4 KB closes it.
- Book channel: the whole book with its sequence, then one `book_update` per settled
  command, carrying the first and last sequence and the new total at each changed level. A
  client resyncs by subscribing again.
- Trades channel: one message per trade with sequence, price, quantity, taker side and time.
  Public channels contain no user id or order id; the tests check message bodies for them.
- Account channel: the user's balances on subscribe, then an `order` event for each of
  their orders a command changed, each followed by the user's balances. Balances carry a
  version, the highest ledger entry id they include, and a client keeps the highest.
- Fan-out through Redis pub/sub:
  - Each market's update goes to `<prefix>market:<symbol>` and each order event to
    `<prefix>user:<id>`.
  - The gateway pattern-subscribes to the market channels, and subscribes to a user's
    channel only while that user is on the account channel.
  - Publishing is fire and forget.
  - A test with two servers on one prefix shows an order matched on one reaching a client
    on the other.
- Heartbeats every 15 s, and termination of a connection that misses a pong or has more
  than 1 MiB unsent.
- Gap test: one real publish is lost while the publisher's Redis is cut. The client counts
  one gap, resyncs at sequence 3 and matches the REST book.
- 303 tests in 20 files, up from 276 in 18.

**What is stubbed**

- A book snapshot comes from the engine in this process. A gateway process without the
  engine would send an empty snapshot; that is fine while there is one API process (multiple
  engine processes are out of scope).
- Delivery is at most once. The trades channel has no sequence continuity of its own, so a
  trade lost in an outage is only visible on the book channel; a client that wants it reads
  `GET /markets/:symbol/trades`.
- A halted market stops publishing. Its subscribers keep the last book they had and get no
  message saying it halted.
- After a restart every market numbers from 1 again. A client that reconnects must take a
  fresh snapshot rather than compare sequences across the restart (Session 10 keeps
  sequences across restarts).
- A connection is authenticated for the life of its token. There is no revocation for a
  socket that is already open.
- Carried over: no test database separate from the dev one, `npm audit` dev-only findings
  from drizzle-kit, the manual `vaidhyam@example.com` row, and the CI workflow has still not
  run on GitHub.

**Decisions and deviations from the plan**

- Added before the WebSocket work: the rate limiter fix, and two refactors (the Redis client
  into `redis.ts`, settlement into `settlement.ts`).
- New dev dependency `@types/ws`: `@fastify/websocket`'s types import `ws` but list its types
  only as a dev dependency, so without it every socket was an unresolved type.
- The book delta carries absolute level totals, not increments, and a sequence range per
  command, not per event.
- Balances on the account channel are read at the gateway, after the order event, rather
  than in the market's queue.
- In tests, an `injectWS` client never answers pings, so the heartbeat test uses Node's own
  `WebSocket` over a real port for the healthy client. The in-memory pipe also absorbs about
  130 KB before the server's send buffer grows, so the slow-consumer test makes a paused
  client request snapshots until it passes the cap.

**Repo shape**

Still flat. New:

- `redis.ts`: the Redis client factory. The rate limiter test needs production's options,
  and `main.ts` starts the server when imported.
- `settlement.ts`: split from `exchange.ts` at 438 lines.
- `ws.ts`: the WebSocket gateway, a new transport.
- `feed.ts`: the publishing side of market data, split from `ws.ts` at 426 lines.

`ws.ts` is at 431 lines again, mostly the gateway's command handling. If Session 7 adds
to it, the account channel is the piece to split out.

**Next: Day 11 — Trading terminal, part 1**

- `chore(web): create the Next.js app with Tailwind and shadcn/ui`
- `feat(web): register and log in with silent token refresh`
- `feat(web): connect to the socket with reconnect, resubscribe and gap recovery`
- `feat(web): show a live order book that updates rows without re-rendering the book`
- `feat(web): show the recent trades feed`
- `feat(web): add an order entry form for limit and market orders`

## Day 11 — Trading terminal, part 1

**Commits landed (12)**

- `feat(api): allow the web origin to call the API with credentials`
- `chore(web): create the Next.js app with Tailwind and shadcn/ui`
- `feat(web): register and log in with silent token refresh`
- `refactor(ws): move the WebSocket protocol types into protocol.ts`
- `feat(web): connect to the socket with reconnect, resubscribe and gap recovery`
- `feat(api): list markets with their tick size, quantity step and minimum`
- `feat(web): show a live order book that updates rows without re-rendering the book`
- `feat(api): include each trade's engine sequence in recent trades`
- `feat(web): show the recent trades feed`
- `feat(web): add an order entry form for limit and market orders`
- `docs: record the trading terminal decisions`
- `docs: record day 11 in PROGRESS.md`

**What now works**

- `web/`: Next.js 16.4 (App Router, Turbopack), Tailwind 4 and shadcn/ui (base-nova), on
  port 3001. `npm run dev --prefix web` starts it.
- The API allows exactly one browser origin, `WEB_ORIGIN` (default `http://localhost:3001`),
  with credentials. The terminal calls it directly; a Next.js proxy under `/api` would never
  receive the `Path=/session` refresh cookie.
- Register, log in and log out. The access token is held in memory only. On load the app
  trades the refresh cookie for a new one; a 401 refreshes once and retries. Concurrent
  refreshes share one request, and tabs take turns under a Web Lock, so the rotating refresh
  token is never sent twice. A failed logout leaves the tab signed in and says so.
- One WebSocket per tab with reference-counted subscriptions. Every connection authenticates
  when signed in and resubscribes to everything wanted. Drops retry with backoff and jitter,
  500 ms doubling to 10 s; close code 4001 refreshes the token and reconnects at once; signing
  out opens a fresh connection.
- Live order book: snapshot then deltas, duplicates dropped, a skipped sequence marks the book
  unsynced and resubscribes for a snapshot. A lost connection dims the book until the next
  snapshot. Prices are sorted and subtracted as BigInt and shown at the tick's precision.
- Render isolation, checked in a browser with temporary render counters: changing the size at
  one level rendered that row only, not the book component.
- Recent trades: 50 from REST, then the trades channel, merged by engine sequence. After a
  reconnect the history is fetched again.
- Order form: buy or sell, limit or market. Off-grid prices and quantities are caught before a
  request, with the API's wording; API errors land on the same fields. A draft keeps its client
  order id across a failed submit, so a retry cannot place a second order.
- API: `GET /markets` lists each market's tick, step and minimum; recent trades now include the
  engine sequence.
- End-to-end check in headless Chromium: log in through the form, reload and come back signed
  in from the cookie, have an off-grid price rejected without a request, and see a limit buy
  rest on the live book.
- `npm run check` ends with web's typecheck, lint and production build. CI installs `web/`'s
  dependencies.
- 343 tests in 25 files, up from 303 in 20. The web tests run under the root Vitest.

**What is stubbed**

- No balances, open orders or cancel in the terminal yet (Day 12). The account channel is
  supported by the socket but nothing subscribes to it.
- The socket has no heartbeat of its own. A silently dead connection is noticed when the
  browser's TCP connection fails; the server side already terminates it within 30 s.
- Trades are merged by sequence, and sequences restart with the API (until Session 10), so
  after a restart an old trade and a new one in the same 50 could share a number.
- The book shows the best 12 levels per side and has no depth bars.
- Verified in Chromium only. Safari's handling of a `Secure` cookie on `http://localhost` is
  unchecked.
- `NEXT_PUBLIC_API_URL` defaults to `http://localhost:3000`; there is no `web/.env.example`,
  since Next's generated `.gitignore` ignores `.env*`.
- `npm audit` in `web/` reports moderate findings in `deepmerge` and `minimatch` from the
  generated dependencies.
- Carried over: no separate test database, drizzle-kit's dev-only audit findings, the manual
  `vaidhyam@example.com` row, and the CI workflow has still not run on GitHub. The browser
  checks added `seed-*@example.com` and `web-*@example.com` users and resting BTC-USD orders
  to the dev database.

**Decisions and deviations from the plan**

- Added: the CORS commit first, `GET /markets` before the book, and the trade sequence in
  recent trades before the feed.
- `ws.ts` did not grow (432 lines), so the account channel was not split out.
- `web/AGENTS.md`, which `next dev` writes when it detects a coding agent, is kept out of git
  through `.git/info/exclude`.
- The web TypeScript target is ES2022, for BigInt literals.
- `engine.property.test.ts` once exceeded its 5 s timeout during a full run while the dev
  servers and a headless browser were running; it takes about 0.9 s alone, and the full gate
  passed twice after they were stopped.

**Repo shape**

- `web/`: the terminal, for its own `package.json`. Inside it, `lib/` holds everything that is
  not React: `session.ts`, `socket.ts`, `book.ts`, `trades.ts`, `markets.ts`, `orders.ts`.
  `components/` holds the client components and shadcn's `ui/`.
- `protocol.ts`: the WebSocket message types, out of `feed.ts`, for the terminal as a second
  consumer. Types only, imported by `web/` through a type-only path alias.

**Next: Day 12 — Trading terminal, part 2 and candles**

- `feat(market): aggregate trades into one-minute OHLCV candles`
- `feat(api): serve candles and stream live candle updates`
- `feat(web): draw a candlestick chart with lightweight-charts`
- `feat(web): show available and reserved balances`
- `feat(web): show open orders with cancel, order history and fills`
