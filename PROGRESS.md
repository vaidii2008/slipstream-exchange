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
