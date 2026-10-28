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
