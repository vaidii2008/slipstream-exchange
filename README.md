# Slipstream

A real-time centralized cryptocurrency exchange simulator: a price-time-priority matching
engine, a double-entry ledger, WebSocket market data, a trading terminal and a fleet of trading
bots that trade in the same order books as human users.

> **Simulator only.** Slipstream moves no real money and no real cryptocurrency. Deposits are
> simulated, there is no custody, no KYC and no connection to any real market, and its prices
> mean nothing. It is a portfolio project, not financial software. Do not run it as a service
> for other people's funds.

## Quick start

Needs Docker with Compose.

```sh
git clone https://github.com/vaidii2008/slipstream-exchange.git
cd slipstream-exchange
docker compose --profile app up
```

Open [http://localhost:3001](http://localhost:3001) and register an account. Eight bots, a
market maker and three noise traders per market, start quoting and trading BTC-USD and ETH-USD
as soon as the API is healthy. Prometheus is on [http://localhost:9090](http://localhost:9090).

Click **Add demo funds** in the balances panel for 100,000 simulated USD, 1 BTC and 10 ETH,
then trade.

The `app` profile builds two images from this repo and runs, in order: Postgres, Redis and
Prometheus; the migrations; the API; then the bot fleet and the terminal. Ports are published
on 127.0.0.1 only. The secrets in `compose.yaml` are fixed demo values so the quick start needs
no `.env`.

**The terminal's API address is baked in at build time.** `NEXT_PUBLIC_API_URL` is read by code
that runs in the browser, so Next.js writes it into the JavaScript bundle when the image is
built, and setting it on a running container does nothing. It is a build argument of
`web/Dockerfile` (default `http://localhost:3000`). The API's `WEB_ORIGIN` must be the
terminal's address as the browser sees it (default `http://localhost:3001`), or CORS refuses
the terminal's requests. To serve it anywhere else, change both and rebuild:

```sh
docker build -f web/Dockerfile --build-arg NEXT_PUBLIC_API_URL=https://api.example.test .
```

### Running from source

Node 24 or later runs the `.ts` files directly; there is no build step for the API.

```sh
cp .env.example .env            # then set JWT_ACCESS_SECRET and BOT_PASSWORD
npm ci
docker compose up -d --wait     # Postgres, Redis and Prometheus only
npx drizzle-kit migrate
npm start                       # API on :3000
npm run bots                    # the bot fleet, in another terminal
cd web && npm ci && npm run dev # terminal on :3001
```

`npm run check` is the gate every commit passes: format, typecheck, lint, the test suite
(466 tests against real Postgres and Redis) and the terminal's typecheck, lint and build.

### Letting a language model trade

`mcp.ts` is a [Model Context Protocol](https://modelcontextprotocol.io) server. A host such as
Claude Desktop or Claude Code starts it as a child process and talks to it over stdin and
stdout. It signs in to the API as one agent account and offers seven tools: `get_market`,
`get_order_book`, `get_recent_trades`, `get_balances`, `get_open_orders`, `place_order` and
`cancel_order`.

It is one more client of the public API, like the terminal and the bots. Every tool call
becomes an HTTP request a person could have made, and every order goes through the same risk
guard as a bot's before it is sent: 0.05 BTC (or 1 ETH) per order, 0.25 BTC (or 5 ETH) of
position, 10 resting orders. If equity falls more than 5,000 USD below where the session
started, a kill switch cancels everything resting and refuses every order after, until the
server is restarted. The model sees each refusal as an error result, with the reason.

Set `AGENT_EMAIL`, `AGENT_PASSWORD` and optionally `AGENT_MARKET` (default `BTC-USD`) and
`AGENT_API_URL`. The account is registered on first start. Fund it from the terminal's "Add
demo funds" button after signing in as it; the model has no deposit tool. A host config looks
like this, with absolute paths:

```json
{
  "mcpServers": {
    "slipstream": {
      "command": "/path/to/node",
      "args": ["/path/to/slipstream-exchange/mcp.ts"],
      "env": {
        "AGENT_API_URL": "http://localhost:3000",
        "AGENT_EMAIL": "agent@agents.slipstream.local",
        "AGENT_PASSWORD": "a-password-of-8-or-more"
      }
    }
  }
}
```

stdout is the protocol channel. Run it as `node mcp.ts` or `npm run --silent mcp`; plain
`npm run mcp` prints npm's banner to stdout, which a host reads as a malformed message.

`place_order` takes a required `clientOrderId`, the API's idempotency key, so a call retried
after a timeout places one order. When the host closes stdin, or the server gets SIGTERM or
SIGINT, it cancels the agent's resting orders and exits, giving up after 3 s.

### Running an agent and measuring it

`agent.ts` is an agent loop without a host: it starts `mcp.ts` as a child, gives its tools to
Claude (`AGENT_MODEL`, default `claude-haiku-5-5`, with `ANTHROPIC_API_KEY`) and runs the
calls the model makes until it stops, runs out of turns or time, or spends its budget. Cost is
priced from the token usage the API reports on each request.

```bash
npm run --silent agent -- --turns 10 --budget 0.05   # one session on AGENT_API_URL
npm run --silent eval -- --episodes 10 --turns 15 --seconds 90 --out results.json
```

`npm run eval` needs Docker and only `ANTHROPIC_API_KEY`. For each seed and each policy it
wipes and restarts a Postgres and Redis under the Compose project `slipstream-eval` (ports 5434
and 6381, never the dev stack's volumes), migrates, starts the API on port 3100 and the BTC-USD
bot fleet with that seed, waits for 20 trades, and funds a new account with 0.1 BTC and
10,000 USD. The policy then trades for 90 s through the MCP server and the account is valued
at the end, whenever the policy stopped. Two policies run on the same seeds: the agent, and a
rule-based baseline that requotes 0.01 BTC one tick inside the best bid and ask every 3 s
through the same tools. A run stops starting agent episodes after 1 USD.

## Architecture

```mermaid
flowchart LR
  browser["Trading terminal<br/>Next.js, in the browser"]
  bots["Bot fleet<br/>fleet.ts, its own process"]

  subgraph api["API process (main.ts)"]
    routes["REST routes<br/>Fastify + zod"]
    gateway["WebSocket gateway<br/>ws.ts"]
    subgraph market["one per market"]
      queue["Serial command queue"] --> engine["Matching engine<br/>pure, in memory"]
      engine --> settle["Settlement<br/>settlement.ts"]
    end
    routes -- "reserve funds, then enqueue" --> queue
  end

  pg[("Postgres<br/>ledger, orders, trades,<br/>engine event log")]
  redis[("Redis<br/>pub/sub, rate limits")]
  prom["Prometheus"]

  browser -- "REST + cookies" --> routes
  browser <-- "book, trades, candles,<br/>own orders, balances" --> gateway
  bots -- "REST, as ordinary users" --> routes
  routes -- "reserve + insert order" --> pg
  queue -- "log command first" --> pg
  settle -- "trades + ledger postings" --> pg
  settle -- "publish update" --> redis
  redis -- "subscribe" --> gateway
  routes -- "rate limit" --> redis
  prom -- "scrape /metrics" --> routes
```

An order's path:

1. **Reserve.** `POST /orders` validates the body with zod and converts amounts to integer
   minor units in `money.ts`, the one place that converts. Then, in one Postgres transaction,
   it locks the user's accounts, moves funds from available to reserved and inserts the order.
2. **Match.** The order joins its market's serial queue. That queue is the engine's only
   writer, so the book needs no locks. The command is appended to `engine_events` before the
   engine applies it. The engine is plain TypeScript with no I/O: price levels in a sorted
   array, FIFO within a level, every event numbered by a per-market sequence.
3. **Settle.** The fills it returns are settled in a second transaction: trades inserted,
   reserved funds moved to each counterparty, order statuses updated. Every balance change is
   a double-entry ledger transaction whose entries sum to zero per asset.
4. **Publish.** The settled command goes to Redis. The gateway sends book deltas, trades,
   candles and private order and balance updates to subscribed sockets.

On boot, each market takes a Postgres advisory lock, so only one process writes it. It then
rebuilds its book by replaying the event log and finishes any settlement a crash interrupted.
It opens only if the rebuilt book matches the orders Postgres says are open.

Money is never a float. Prices and quantities are `bigint` minor units in the engine and
`NUMERIC(36,18)` in Postgres. An amount with more decimals than its asset allows is rejected,
never rounded.

## Results

Every number below was measured in this repo. **Engine-only** means `npm run bench`: the engine
in one process, no I/O. **End to end** means k6 driving the HTTP API, through the reservation,
the event log, the settlement and Redis, against a database created for the runs, with the
bots stopped.

**Machine and date:** MacBook, Apple M4 (10 cores, 16 GB), Node 24.21.0; Postgres 16 and Redis 7
in Docker Desktop (10 CPUs, 7.75 GB); k6 1.2.3 in Docker. 7 November 2026.

| Kind        | What                                                                   | Result                                                      |
| ----------- | ---------------------------------------------------------------------- | ----------------------------------------------------------- |
| Engine-only | Mixed commands on a book near 5,000 resting orders                     | 4,305,856 commands/s; p50 0.21 µs, p99 0.54 µs              |
| Engine-only | One price level near 10,000 orders                                     | 2,258,113 commands/s; cancel p99 1.54 µs                    |
| End to end  | One market, ramped until its queue saturates (near-empty ledger)       | ~264 commands/s                                             |
| End to end  | Both markets, ramped to 600/s offered, ledger of 3.6M entries          | peak 325–360/s; 269–300/s saturated                         |
| End to end  | Placement latency at a steady 200/s, both markets, 3.6M entries        | p50 7.5 ms, p95 24 ms, p99 57 ms                            |
| End to end  | The match inside a placement (200/s steady)                            | p50 4.1 µs                                                  |
| End to end  | Trade to subscriber, 200 sockets, 100 orders/s                         | p50 18 ms, p95 44 ms, p99 69 ms; no gap in 1,791,445 deltas |
| End to end  | Boot: replay the log until `/health` answers, 118,271 / 1,011,453 cmds | 0.76–1.12 s / 3.3–4.1 s                                     |

The engine is four orders of magnitude faster than the exchange around it. A market runs one
command at a time, so its ceiling is one over the time a command takes, about 3.8 ms. That time
is mostly Postgres round trips: a resting order sends 16 statements over its life, a crossing
order 43. The 4 µs match is a rounding error inside it. The trade-to-subscriber delay
compares k6's container clock with the host's, which disagree by at least 12 ms.

### Agent evals

Ten seeds, each run once per policy: 20 episodes of 90 s on BTC-USD, `claude-haiku-5-5`, at
most 15 turns, 8 November 2026, same machine. P&L is in USD from 0.1 BTC and 10,000 USD
(about 17,000 USD of equity), rounded to the cent. **Over holding** subtracts what keeping
the starting 0.1 BTC and never trading made over the same 90 s, valued at the same marks.

| Policy   | Mean P&L | Range         | Mean over holding | Beat holding | Fills per episode | Risk / invalid / exchange refusals |       Cost |
| -------- | -------: | ------------- | ----------------: | -----------: | ----------------: | ---------------------------------- | ---------: |
| Agent    |     3.01 | −4.56 to 8.41 |            −0.002 |         6/10 |               5.7 | 0 / 0 / 0 in 280 tool calls        | 0.0346 USD |
| Baseline |     1.80 | −1.58 to 4.00 |             +0.66 |        10/10 |              88.8 | 0 / 0 / 0                          |          0 |

- **The agent's higher P&L is the market's, not its trading.** Its P&L over holding ranged from
  −0.34 to +0.25 USD and averaged −0.002. In its episodes BTC happened to rise more: holding
  alone made 3.01 USD on average there and 1.14 in the baseline's. The baseline earned the
  spread in every seed, 0.07 to 1.00 USD over holding, from about 89 maker fills an episode.
- **One seed is not one market.** The bots' choices repeat with the seed, but HTTP latency
  decides which order reaches the book first, so the same seed's two episodes diverge. On
  seed 1 holding made 5.75 USD in the agent's episode and 3.90 in the baseline's. That is why
  every score here is over holding and over ten seeds, and why ten seeds still only say the
  baseline is ahead on this setup, not by how much in general.
- **The agent made no invalid calls.** 280 tool calls, 42 orders, no schema errors, no off-grid
  prices, no risk refusals. It placed few orders and mostly read: 75 `get_open_orders` and 66
  `get_order_book` calls. It ended its own session before its turns ran out in 6 of 10 episodes,
  after 7 to 12 turns, although the prompt says ending early cancels its quotes.
- **Tokens.** 111 requests, 825,173 prompt tokens, of which 737,173 were cache reads, and
  32,405 output tokens: 0.0035 USD an episode at Haiku 5.5's rates.

## Three things the measurements found

**The ledger deadlock.** A reserve and a release on the same user and asset could deadlock. Each
held `FOR UPDATE` on the account it debited. Inserting its entry needed `FOR KEY SHARE` on the
other account for the foreign-key check, and `FOR UPDATE` blocks that. With 40 interleaved
reserves and releases, **36 died with deadlock errors (40P01). With `FOR NO KEY UPDATE`, 0
did.** That lock doesn't conflict with the foreign-key check, and it still makes two writers of
one account queue. Later, the cached balance (below) meant credited accounts had to be locked
too. Locking them in posting order brought it back: **29 deadlocks in 40 opposite-direction
trades. Locking every account up front in id order: 0.** Lock order is the whole fix. Two
transactions that ask for the same rows in the same order queue instead of deadlocking.
(`lockAccounts` in `ledger.ts`.)

**The quadratic boot check.** Before a market opens, recovery checks that every order Postgres
calls open is on the rebuilt book. It did that with `resting.some(...)` for each open order:
open × resting comparisons. The kill test, with tens of orders resting, never noticed. At 1M
logged commands, with about 31,000 orders resting per market, **the check took 2.8–3.6 s of each
market's boot and launch to healthy was 9.3–10.9 s. With a set of resting ids, the check takes
0.2–0.4 s and launch to healthy is 3.3–4.1 s.** (`checkBook` in `recovery.ts`.)

**The cached balance.** A balance was the sum of an account's ledger entries, recomputed by every
reservation and settlement under the account's row lock. Filling the log to 1M commands at a
fixed offered rate, throughput fell chunk by chunk from about 250 to 123 commands/s while the
match stayed under 10 µs. The sums were growing with history. Each account now caches the sum,
updated in the same transaction as its entries, under the same lock. A test checks every
account in the database for a cached balance that differs from its entries. On fresh copies of
one database padded to 3.6M entries, at a steady 200/s: **placement p50 28.9 ms → 7.5 ms, p99
1.23 s → 57 ms; saturated throughput 179–212/s → 269–300/s.** Balance reads, which the bots make
every tick, now read the cached column too. On the same padded database, one user's read went
from 7.0–7.5 ms to 0.07–0.21 ms, a single Postgres query timed in `psql` with a warm cache.
(`postTransaction` and `accountState` in `ledger.ts`.)

## Known limits

- **Sockets share the matching event loop.** The engine, its settlements and the WebSocket
  fan-out run on one Node event loop. At 220 orders/s with 200 subscribers the process sent
  about 25,000 messages a second, event-loop lag p99 reached 89 ms, and throughput fell to
  177/s. Redis pub/sub already allows moving the gateway to its own process; it hasn't been
  done.
- **Boot replays the whole log.** There are no snapshots, so every boot reads and replays each
  market from its first command: about 3.5 s of downtime per million commands on this machine,
  growing with the log. The whole log is in memory during replay, 1.5–1.6 GB peak at 1M
  commands.
- **`/metrics` is unauthenticated.** It exposes counts and latencies per market, never user or
  order ids, but anyone who can reach the API can read it. A real deployment would serve it on
  a separate, private listener.
- **One process per market.** The advisory lock refuses a second writer, but a settlement
  already in flight when the lock drops still commits. The trades table's unique (market,
  sequence) makes a double settlement fail and halt rather than pay twice.
- **The MCP server's limits last one process.** The position and loss limits count from where
  the server started, and a tripped kill switch resets on restart.
- **The evals are small.** One model, one market, one prompt, ten seeds of 90 s, each run once.
  The prompt was changed once before the measured run, after a single smoke episode showed the
  model ending its session straight after quoting.
- **A market's ceiling is its round trips.** One command at a time means one market tops out
  at a few hundred commands a second here. Settling several queued commands per transaction is
  the lever, and it is not built.

## Where things live

The repo is flat on purpose. A module got its own file only when something forced it. The
reasons are in the commit history: each `refactor:` commit names its pressure.

| File                              | What                                                         |
| --------------------------------- | ------------------------------------------------------------ |
| `engine.ts`, `book.ts`            | The matching engine and its order book. Pure, no I/O.        |
| `exchange.ts`                     | Per-market serial queues, boot, halts.                       |
| `marketlock.ts`                   | The per-market Postgres advisory lock.                       |
| `ledger.ts`                       | Double-entry ledger, row locking, cached balances.           |
| `orders.ts`, `settlement.ts`      | Reserve-and-record, then settle fills.                       |
| `events.ts`, `recovery.ts`        | The engine event log, replay and crash recovery.             |
| `trading.ts`, `wallet.ts`         | Order and balance routes.                                    |
| `ws.ts`, `feed.ts`, `protocol.ts` | WebSocket gateway, Redis feed, the wire types.               |
| `client.ts`                       | The typed HTTP client the bots and the MCP server share.     |
| `risk.ts`                         | Pre-trade limits, the loss limit and cancel-all.             |
| `bots.ts`, `strategies.ts`        | Bot runtime, market maker and noise trader.                  |
| `mcp.ts`                          | The MCP server that lets a language model trade.             |
| `agent.ts`                        | The agent loop: Claude, the MCP tools, the token budget.     |
| `evals.ts`, `score.ts`            | Eval episodes on a fresh stack, and their scores.            |
| `baseline.ts`                     | The rule-based policy the agent is measured against.         |
| `money.ts`                        | The only conversion between decimal strings and minor units. |
| `web/`                            | The trading terminal.                                        |
| `load/`                           | k6 scripts and the bench database tool.                      |
| `DECISIONS.md`                    | Every design decision, the alternative and why.              |

## License

MIT. See `LICENSE`.
