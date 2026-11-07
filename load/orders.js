// Order placement load, run by k6 in its Docker image against an API on the host:
//
//   docker run --rm -v "$PWD/load:/load" -e PROFILE=ramp grafana/k6:1.2.3 run /load/orders.js
//
// An open model: k6 starts iterations at a set rate whether or not earlier ones have
// finished, as real clients would. A closed model (each virtual user waits for its reply
// before the next order) slows down with the server and hides how long orders wait.
//
// Each iteration places a limit order or cancels one placed earlier. Prices fall either side
// of a fixed mid, so about half the orders cross the book and trade, and the cancels keep
// the book from growing without bound over a long run.
//
// Environment: PROFILE (ramp or steady), RATE and DURATION (steady only), USERS, MARKETS
// (comma-separated), API_URL.

import { check } from "k6";
import exec from "k6/execution";
import http from "k6/http";
import { Counter, Trend } from "k6/metrics";

const API = __ENV.API_URL || "http://host.docker.internal:3000";
// Orders go to users in turn, so each user gets RATE / USERS a second. At the default 300
// users, the 20 a second limit is reached only past 6,000 orders a second.
const USERS = Number(__ENV.USERS || 300);
const MARKETS = (__ENV.MARKETS || "BTC-USD").split(",");
const PASSWORD = "bench-password-not-secret";

// Mid price, quantity step and the steps an order's quantity may span, per market. Quantities
// stay a few multiples of the minimum so a crossing order takes one or two makers.
const GRID = {
  "BTC-USD": { mid: 60000, step: 0.0001, decimals: 4, minSteps: 10, maxSteps: 200 },
  "ETH-USD": { mid: 3000, step: 0.001, decimals: 3, minSteps: 10, maxSteps: 200 },
};

const PROFILES = {
  // Rising until the server cannot keep up: the rate where latency climbs and iterations are
  // dropped is the ceiling.
  ramp: {
    executor: "ramping-arrival-rate",
    startRate: 100,
    timeUnit: "1s",
    preAllocatedVUs: 200,
    maxVUs: 2000,
    stages: [
      { target: 500, duration: "30s" },
      { target: 1000, duration: "30s" },
      { target: 1500, duration: "30s" },
      { target: 2000, duration: "30s" },
      { target: 3000, duration: "30s" },
      { target: 4000, duration: "30s" },
    ],
  },
  // A fixed rate held for a while, to read latency at a load the server can sustain.
  steady: {
    executor: "constant-arrival-rate",
    rate: Number(__ENV.RATE || 500),
    timeUnit: "1s",
    duration: __ENV.DURATION || "5m",
    preAllocatedVUs: 200,
    maxVUs: 2000,
  },
};

export const options = {
  scenarios: { orders: PROFILES[__ENV.PROFILE || "ramp"] },
  setupTimeout: "10m",
  summaryTrendStats: ["avg", "min", "med", "p(90)", "p(95)", "p(99)", "max"],
};

// Latency of accepted placements only: a 429 is answered before any work and would pull the
// percentiles down.
const placeLatency = new Trend("place_ms", true);
const cancelLatency = new Trend("cancel_ms", true);
const placed = new Counter("orders_placed");
const rateLimited = new Counter("orders_rate_limited");
const busy = new Counter("orders_busy");
const refused = new Counter("orders_refused");
const cancelled = new Counter("orders_cancelled");
const cancelsTooLate = new Counter("cancels_too_late");
const failed = new Counter("requests_failed");

// Logs the first few unexpected replies from each virtual user, so a failure shows its cause
// without one line per request flooding the output.
let reported = 0;
function unexpected(response) {
  failed.add(1);
  if (reported++ < 3) {
    console.warn(`unexpected ${response.request.method} ${response.status}: ${response.body}`);
  }
}

const json = (body, token) => ({
  headers: {
    "content-type": "application/json",
    ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
  },
});

// Registers USERS accounts (or signs in to them, on a later run) and funds each one.
export function setup() {
  const tokens = [];
  const batch = 25;
  for (let start = 0; start < USERS; start += batch) {
    const emails = [];
    for (let i = start; i < Math.min(start + batch, USERS); i++) {
      emails.push(`bench-${i}@slipstream.bench`);
    }
    const body = (email) => JSON.stringify({ email, password: PASSWORD });
    const registered = http.batch(
      emails.map((email) => ["POST", `${API}/register`, body(email), json()]),
    );
    for (const response of registered) {
      if (response.status !== 201 && response.status !== 409) {
        throw new Error(`register failed: ${response.status} ${response.body}`);
      }
    }
    const loggedIn = http.batch(
      emails.map((email) => ["POST", `${API}/login`, body(email), json()]),
    );
    for (const response of loggedIn) {
      if (response.status !== 200) {
        throw new Error(`login failed: ${response.status} ${response.body}`);
      }
      tokens.push(response.json("accessToken"));
    }
  }

  const holdings = [
    ["USD", "100000000"],
    ["BTC", "10000"],
    ["ETH", "100000"],
  ];
  for (let start = 0; start < tokens.length; start += batch) {
    const requests = [];
    for (const token of tokens.slice(start, start + batch)) {
      for (const [asset, amount] of holdings) {
        requests.push([
          "POST",
          `${API}/deposits`,
          JSON.stringify({ asset, amount }),
          json(undefined, token),
        ]);
      }
    }
    for (const response of http.batch(requests)) {
      if (response.status !== 201) {
        throw new Error(`deposit failed: ${response.status} ${response.body}`);
      }
    }
  }
  return { tokens };
}

// Orders this virtual user placed that were resting when placed, oldest first, with the
// token of the user who owns each. Kept per virtual user: k6 shares nothing between them.
const resting = [];
const MAX_RESTING = 50;

function place(token) {
  const market = MARKETS[Math.floor(Math.random() * MARKETS.length)];
  const grid = GRID[market];
  const side = Math.random() < 0.5 ? "buy" : "sell";
  // From 20 below to 20 above the mid, in whole dollars: a buy above the mid or a sell below
  // it usually crosses.
  const offset = Math.floor(Math.random() * 41) - 20;
  const price = side === "buy" ? grid.mid + offset : grid.mid - offset;
  const steps = grid.minSteps + Math.floor(Math.random() * (grid.maxSteps - grid.minSteps));
  const quantity = (steps * grid.step).toFixed(grid.decimals);

  const response = http.post(
    `${API}/orders`,
    JSON.stringify({ market, side, type: "limit", price: price.toFixed(2), quantity }),
    { ...json(undefined, token), tags: { name: "POST /orders" } },
  );
  if (response.status === 201) {
    placed.add(1);
    placeLatency.add(response.timings.duration);
    if (response.json("status") === "open") {
      resting.push({ id: response.json("id"), token });
    }
  } else if (response.status === 429) {
    rateLimited.add(1);
  } else if (response.status === 503) {
    busy.add(1);
  } else if (response.status >= 400 && response.status < 500) {
    refused.add(1);
  } else {
    unexpected(response);
  }
  check(response, { "order accepted or limited": (r) => [201, 429, 503].includes(r.status) });
}

function cancelOldest() {
  const order = resting.shift();
  // No content type: Fastify refuses a JSON content type with an empty body.
  const response = http.del(`${API}/orders/${order.id}`, null, {
    headers: { authorization: `Bearer ${order.token}` },
    tags: { name: "DELETE /orders/:id" },
  });
  if (response.status === 200) {
    cancelled.add(1);
    cancelLatency.add(response.timings.duration);
  } else if (response.status === 409) {
    // Filled since it was placed.
    cancelsTooLate.add(1);
  } else if (response.status === 503) {
    busy.add(1);
  } else {
    unexpected(response);
  }
}

export default function ({ tokens }) {
  if (resting.length > MAX_RESTING || (resting.length > 0 && Math.random() < 0.3)) {
    cancelOldest();
    return;
  }
  // In turn across every iteration of the run, not per virtual user: k6 hands iterations to
  // whichever virtual user is free, so a count per virtual user would load some users far
  // more than others.
  const token = tokens[exec.scenario.iterationInTest % tokens.length];
  place(token);
}
