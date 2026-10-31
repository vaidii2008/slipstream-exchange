import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { BookSnapshot, Side } from "./book.ts";
import { Engine, type EngineEvent, type NewOrder } from "./engine.ts";

// A command as generated, before ids are assigned. Cancels point at an earlier order by
// position, so they hit real ids, some resting and some already gone.
type Command =
  | { kind: "limit"; userId: string; side: Side; price: bigint; quantity: bigint }
  | { kind: "market"; userId: string; side: Side; quantity: bigint }
  | { kind: "cancel"; target: number };

// Three users and a narrow price band, so orders cross often and the same user often meets
// their own orders.
const user = fc.constantFrom("alice", "bob", "carol");
const side = fc.constantFrom<Side>("buy", "sell");
const price = fc.bigInt({ min: 95n, max: 105n });
const quantity = fc.bigInt({ min: 1n, max: 20n });

const command: fc.Arbitrary<Command> = fc.oneof(
  {
    weight: 6,
    arbitrary: fc.record({ kind: fc.constant("limit"), userId: user, side, price, quantity }),
  },
  {
    weight: 2,
    arbitrary: fc.record({ kind: fc.constant("market"), userId: user, side, quantity }),
  },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("cancel"), target: fc.nat() }) },
);

// fast-check's default size caps arrays at about 10 elements whatever maxLength says; "large"
// gives a median near 90 commands, enough for deep books and long cancel chains.
const commands = fc.array(command, { maxLength: 200, size: "large" });

type Run = {
  events: EngineEvent[];
  orders: NewOrder[];
  // The book after each command, for checks that must hold at every step.
  books: BookSnapshot[];
  final: BookSnapshot;
};

function run(sequence: Command[]): Run {
  const engine = new Engine("PROP");
  const events: EngineEvent[] = [];
  const orders: NewOrder[] = [];
  const books: BookSnapshot[] = [];

  for (const next of sequence) {
    if (next.kind === "cancel") {
      const target = orders[next.target % Math.max(orders.length, 1)];
      events.push(...engine.cancel(target?.id ?? "nothing-yet"));
    } else {
      const id = `o${orders.length + 1}`;
      const order: NewOrder =
        next.kind === "limit"
          ? {
              type: "limit",
              id,
              userId: next.userId,
              side: next.side,
              price: next.price,
              quantity: next.quantity,
            }
          : { type: "market", id, userId: next.userId, side: next.side, quantity: next.quantity };
      orders.push(order);
      events.push(...engine.submit(order));
    }
    books.push(engine.snapshot());
  }
  return { events, orders, books, final: engine.snapshot() };
}

describe("engine invariants over random command sequences", () => {
  it("never leaves the book crossed, unsorted or with an empty level", () => {
    fc.assert(
      fc.property(commands, (sequence) => {
        for (const book of run(sequence).books) {
          const bestBid = book.bids[0]?.price;
          const bestAsk = book.asks[0]?.price;
          if (bestBid !== undefined && bestAsk !== undefined) {
            expect(bestBid).toBeLessThan(bestAsk);
          }
          for (const [levels, better] of [
            [book.bids, (a: bigint, b: bigint) => a > b],
            [book.asks, (a: bigint, b: bigint) => a < b],
          ] as const) {
            levels.forEach((level, i) => {
              expect(level.orders.length).toBeGreaterThan(0);
              const next = levels[i + 1];
              if (next !== undefined) {
                expect(better(level.price, next.price)).toBe(true);
              }
            });
          }
        }
      }),
      { numRuns: 300 },
    );
  });

  it("conserves every order's quantity across fills, cancels and what still rests", () => {
    fc.assert(
      fc.property(commands, (sequence) => {
        const { events, orders, final } = run(sequence);
        const accounted = new Map<string, bigint>();
        const add = (id: string, amount: bigint) =>
          accounted.set(id, (accounted.get(id) ?? 0n) + amount);

        for (const event of events) {
          if (event.type === "trade") {
            add(event.makerOrderId, event.quantity);
            add(event.takerOrderId, event.quantity);
          } else if (event.type === "cancelled") {
            add(event.orderId, event.quantity);
          }
        }
        for (const level of [...final.bids, ...final.asks]) {
          for (const resting of level.orders) {
            add(resting.id, resting.remaining);
          }
        }

        for (const order of orders) {
          expect(accounted.get(order.id) ?? 0n).toBe(order.quantity);
        }
      }),
      { numRuns: 300 },
    );
  });

  it("only trades at prices the taker accepted, never with the same user", () => {
    fc.assert(
      fc.property(commands, (sequence) => {
        const { events, orders } = run(sequence);
        const byId = new Map(orders.map((order) => [order.id, order]));

        for (const event of events) {
          if (event.type !== "trade") {
            continue;
          }
          expect(event.makerUserId).not.toBe(event.takerUserId);
          const taker = byId.get(event.takerOrderId);
          if (taker?.type === "limit") {
            if (taker.side === "buy") {
              expect(event.price).toBeLessThanOrEqual(taker.price);
            } else {
              expect(event.price).toBeGreaterThanOrEqual(taker.price);
            }
          }
        }
      }),
      { numRuns: 300 },
    );
  });

  it("numbers events 1, 2, 3, ... with no gaps or repeats", () => {
    fc.assert(
      fc.property(commands, (sequence) => {
        const { events } = run(sequence);

        expect(events.map((event) => event.sequence)).toEqual(events.map((_, index) => index + 1));
      }),
      { numRuns: 300 },
    );
  });

  it("produces the same events and book from the same commands every time", () => {
    fc.assert(
      fc.property(commands, (sequence) => {
        const first = run(sequence);
        const second = run(sequence);

        expect(second.events).toEqual(first.events);
        expect(second.final).toEqual(first.final);
      }),
      { numRuns: 300 },
    );
  });
});
