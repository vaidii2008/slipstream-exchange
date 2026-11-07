// Market data subscribers, run by k6 beside orders.js while it trades:
//
//   docker run --rm -v "$PWD/load:/load" -e SUBSCRIBERS=500 grafana/k6:1.2.3 run /load/sockets.js
//
// Each virtual user holds one WebSocket subscribed to a market's trades and book, and
// measures how long each trade took to reach it and whether its book deltas arrived without
// a gap. The delay is this container's clock against the API's, both on one machine.
//
// Environment: SUBSCRIBERS, DURATION, MARKET, API_URL.

import { check } from "k6";
import ws from "k6/ws";
import { Counter, Trend } from "k6/metrics";

const API = __ENV.API_URL || "http://host.docker.internal:3000";
const MARKET = __ENV.MARKET || "BTC-USD";
const DURATION = __ENV.DURATION || "3m";

const seconds = (duration) => {
  const match = /^(\d+)([sm])$/.exec(duration);
  return Number(match[1]) * (match[2] === "m" ? 60 : 1);
};

export const options = {
  scenarios: {
    // One iteration each: a virtual user's iteration is its one long connection.
    subscribers: {
      executor: "per-vu-iterations",
      vus: Number(__ENV.SUBSCRIBERS || 200),
      iterations: 1,
      maxDuration: `${seconds(DURATION) + 30}s`,
    },
  },
  summaryTrendStats: ["avg", "min", "med", "p(90)", "p(95)", "p(99)", "max"],
};

// From the trade's settlement, as the API stamped it, to its arrival here.
const tradeDelay = new Trend("trade_delay_ms", true);
const trades = new Counter("trades_received");
const deltas = new Counter("book_deltas_received");
// A delta whose first sequence is not the one after the last: something was missed, and a
// terminal would resubscribe for a fresh snapshot.
const gaps = new Counter("book_gaps");

export default function () {
  const url = `${API.replace(/^http/, "ws")}/ws`;
  const response = ws.connect(url, {}, (socket) => {
    let last;
    socket.on("open", () => {
      // So the summary shows 0 gaps rather than leaving the counter out.
      gaps.add(0);
      socket.send(JSON.stringify({ op: "subscribe", channel: "trades", market: MARKET }));
      socket.send(JSON.stringify({ op: "subscribe", channel: "book", market: MARKET }));
    });
    socket.on("message", (text) => {
      const message = JSON.parse(text);
      if (message.type === "trade") {
        trades.add(1);
        tradeDelay.add(Date.now() - Date.parse(message.time));
      } else if (message.type === "book") {
        last = message.sequence;
      } else if (message.type === "book_update" && last !== undefined) {
        // Deltas at or below the snapshot's sequence are already in it.
        if (message.sequence <= last) {
          return;
        }
        deltas.add(1);
        if (message.firstSequence !== last + 1) {
          gaps.add(1);
        }
        last = message.sequence;
      }
    });
    socket.setTimeout(() => socket.close(), seconds(DURATION) * 1000);
  });
  check(response, { "upgraded to a WebSocket": (r) => r && r.status === 101 });
}
