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
