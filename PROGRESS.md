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
