import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  balancesOf,
  deposit,
  LedgerError,
  openAccount,
  postTransaction,
  release,
  reserve,
} from "./ledger.ts";
import { fromNumeric } from "./money.ts";
import { ledgerEntries, users } from "./schema.ts";
import { useTestServer } from "./testing.ts";

const { db, uniqueEmail } = useTestServer();

// The ledger only needs a users row to point at, not a real password.
async function createUser(): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({ email: uniqueEmail("ledger-test"), passwordHash: "not-a-real-hash" })
    .returning({ id: users.id });
  if (user === undefined) {
    throw new Error("user insert returned no row");
  }
  return user.id;
}

async function entriesOf(accountId: number, scale: number): Promise<bigint[]> {
  const rows = await db
    .select({ amount: ledgerEntries.amount })
    .from(ledgerEntries)
    .where(eq(ledgerEntries.accountId, accountId))
    .orderBy(ledgerEntries.id);
  return rows.map((row) => fromNumeric(row.amount, scale));
}

async function expectLedgerError(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(LedgerError);
  await expect(promise).rejects.toMatchObject({ code });
}

describe("openAccount", () => {
  it("returns the same account every time it is asked", async () => {
    const userId = await createUser();

    const first = await openAccount(db, userId, "BTC", "available");
    const second = await openAccount(db, userId, "BTC", "available");
    const reserved = await openAccount(db, userId, "BTC", "reserved");

    expect(second).toBe(first);
    expect(reserved).not.toBe(first);
  });

  it("creates one account when many callers race to open it", async () => {
    const userId = await createUser();

    const ids = await Promise.all(
      Array.from({ length: 8 }, () => openAccount(db, userId, "ETH", "available")),
    );

    expect(new Set(ids).size).toBe(1);
  });

  it("shares one system account per asset", async () => {
    const first = await openAccount(db, null, "USD", "available");
    const second = await openAccount(db, null, "USD", "available");

    expect(second).toBe(first);
  });
});

describe("postTransaction", () => {
  it("writes both sides of a balanced deposit", async () => {
    const userId = await createUser();
    const system = await openAccount(db, null, "BTC", "available");
    const available = await openAccount(db, userId, "BTC", "available");

    const transactionId = await postTransaction(db, "deposit", [
      { accountId: system, amount: -150_000_000n },
      { accountId: available, amount: 150_000_000n },
    ]);

    expect(transactionId).toBeGreaterThan(0);
    await expect(entriesOf(available, 8)).resolves.toEqual([150_000_000n]);
  });

  it("rejects entries that do not sum to zero and writes nothing", async () => {
    const userId = await createUser();
    const system = await openAccount(db, null, "BTC", "available");
    const available = await openAccount(db, userId, "BTC", "available");

    await expectLedgerError(
      postTransaction(db, "deposit", [
        { accountId: system, amount: -100n },
        { accountId: available, amount: 101n },
      ]),
      "unbalanced",
    );

    await expect(entriesOf(available, 8)).resolves.toEqual([]);
  });

  it("checks the balance per asset, so BTC cannot pay for USD", async () => {
    const userId = await createUser();
    const btc = await openAccount(db, userId, "BTC", "available");
    const usd = await openAccount(db, userId, "USD", "available");

    await expectLedgerError(
      postTransaction(db, "trade", [
        { accountId: btc, amount: 500n },
        { accountId: usd, amount: -500n },
      ]),
      "unbalanced",
    );

    await expect(entriesOf(btc, 8)).resolves.toEqual([]);
  });

  it("rejects a zero posting", async () => {
    const userId = await createUser();
    const system = await openAccount(db, null, "BTC", "available");
    const available = await openAccount(db, userId, "BTC", "available");

    await expectLedgerError(
      postTransaction(db, "deposit", [
        { accountId: system, amount: 0n },
        { accountId: available, amount: 0n },
      ]),
      "zero_amount",
    );
  });

  it("rejects a transaction with a single posting", async () => {
    const userId = await createUser();
    const available = await openAccount(db, userId, "BTC", "available");

    await expectLedgerError(
      postTransaction(db, "deposit", [{ accountId: available, amount: 1n }]),
      "too_few_postings",
    );
  });

  it("rejects a posting to an account that does not exist", async () => {
    const system = await openAccount(db, null, "BTC", "available");

    await expectLedgerError(
      postTransaction(db, "deposit", [
        { accountId: system, amount: -1n },
        { accountId: Number.MAX_SAFE_INTEGER, amount: 1n },
      ]),
      "unknown_account",
    );
  });

  it("rolls back the transaction row when an entry fails to insert", async () => {
    const userId = await createUser();
    const system = await openAccount(db, null, "USD", "available");
    const available = await openAccount(db, userId, "USD", "available");
    // Balanced, but 10^40 minor units overflows NUMERIC(36,18), so the entry insert fails
    // after the transaction row is already written.
    const tooLarge = 10n ** 40n;

    await expect(
      postTransaction(db, "deposit", [
        { accountId: system, amount: -tooLarge },
        { accountId: available, amount: tooLarge },
      ]),
    ).rejects.toThrow();

    await expect(entriesOf(available, 8)).resolves.toEqual([]);
    const orphans = await db.execute<{ count: string }>(sql`
      select count(*) as count from ledger_transactions t
      where not exists (select 1 from ledger_entries e where e.transaction_id = t.id)`);
    expect(orphans.rows[0]?.count).toBe("0");
  });
});

describe("balancesOf", () => {
  it("lists every asset at zero for a user with no entries", async () => {
    const userId = await createUser();

    await expect(balancesOf(db, userId)).resolves.toEqual([
      { asset: "BTC", scale: 8, available: 0n, reserved: 0n },
      { asset: "ETH", scale: 8, available: 0n, reserved: 0n },
      { asset: "USD", scale: 8, available: 0n, reserved: 0n },
    ]);
  });

  it("sums each bucket's entries separately and ignores other users", async () => {
    const userId = await createUser();
    const someoneElse = await createUser();
    await deposit(db, userId, "BTC", 300n);
    await deposit(db, userId, "BTC", 200n);
    await deposit(db, someoneElse, "BTC", 999n);
    await postTransaction(db, "reserve", [
      { accountId: await openAccount(db, userId, "BTC", "available"), amount: -120n },
      { accountId: await openAccount(db, userId, "BTC", "reserved"), amount: 120n },
    ]);

    const balances = await balancesOf(db, userId);

    expect(balances.find((balance) => balance.asset === "BTC")).toEqual({
      asset: "BTC",
      scale: 8,
      available: 380n,
      reserved: 120n,
    });
  });
});

describe("reserve and release", () => {
  async function btcOf(userId: string) {
    const balances = await balancesOf(db, userId);
    const btc = balances.find((balance) => balance.asset === "BTC");
    return { available: btc?.available, reserved: btc?.reserved };
  }

  it("moves funds from available to reserved and back", async () => {
    const userId = await createUser();
    await deposit(db, userId, "BTC", 100n);

    await reserve(db, userId, "BTC", 70n);
    await expect(btcOf(userId)).resolves.toEqual({ available: 30n, reserved: 70n });

    await release(db, userId, "BTC", 25n);
    await expect(btcOf(userId)).resolves.toEqual({ available: 55n, reserved: 45n });
  });

  it("refuses to reserve more than is available and changes nothing", async () => {
    const userId = await createUser();
    await deposit(db, userId, "BTC", 100n);

    await expectLedgerError(reserve(db, userId, "BTC", 101n), "insufficient_funds");

    await expect(btcOf(userId)).resolves.toEqual({ available: 100n, reserved: 0n });
  });

  it("does not let reserved funds be reserved twice", async () => {
    const userId = await createUser();
    await deposit(db, userId, "BTC", 100n);
    await reserve(db, userId, "BTC", 60n);

    await expectLedgerError(reserve(db, userId, "BTC", 50n), "insufficient_funds");

    await expect(btcOf(userId)).resolves.toEqual({ available: 40n, reserved: 60n });
  });

  it("refuses to release more than is reserved", async () => {
    const userId = await createUser();
    await deposit(db, userId, "BTC", 100n);
    await reserve(db, userId, "BTC", 10n);

    await expectLedgerError(release(db, userId, "BTC", 11n), "insufficient_funds");

    await expect(btcOf(userId)).resolves.toEqual({ available: 90n, reserved: 10n });
  });

  it("refuses a user with no funds at all", async () => {
    const userId = await createUser();

    await expectLedgerError(reserve(db, userId, "BTC", 1n), "insufficient_funds");
  });

  it("stops any posting from overdrawing a user, not just reservations", async () => {
    const payer = await createUser();
    const payee = await createUser();
    await deposit(db, payer, "BTC", 5n);

    await expectLedgerError(
      postTransaction(db, "trade", [
        { accountId: await openAccount(db, payer, "BTC", "available"), amount: -6n },
        { accountId: await openAccount(db, payee, "BTC", "available"), amount: 6n },
      ]),
      "insufficient_funds",
    );
  });

  it("lets the system account go negative, since deposits are drawn from it", async () => {
    const userId = await createUser();

    await deposit(db, userId, "ETH", 1n);

    const [system] = await db
      .execute<{ total: string }>(
        sql`
      select coalesce(sum(e.amount), 0) as total
      from ledger_entries e join ledger_accounts a on a.id = e.account_id
      where a.user_id is null and a.asset = 'ETH'`,
      )
      .then((result) => result.rows);
    expect(fromNumeric(system?.total ?? "0", 8)).toBeLessThan(0n);
  });
});

describe("concurrent reservations", () => {
  it("lets exactly 10 of 50 parallel reservations of 10 through against a balance of 100", async () => {
    const userId = await createUser();
    await deposit(db, userId, "USD", 100n);

    const outcomes = await Promise.allSettled(
      Array.from({ length: 50 }, () => reserve(db, userId, "USD", 10n)),
    );

    const succeeded = outcomes.filter((outcome) => outcome.status === "fulfilled");
    const refusals = outcomes.flatMap((outcome) =>
      outcome.status === "rejected" ? [outcome.reason as unknown] : [],
    );
    expect(succeeded).toHaveLength(10);
    expect(refusals).toHaveLength(40);
    for (const reason of refusals) {
      expect(reason).toMatchObject({ code: "insufficient_funds" });
    }

    const usd = (await balancesOf(db, userId)).find((balance) => balance.asset === "USD");
    expect(usd).toMatchObject({ available: 0n, reserved: 100n });
  });

  // A reserve debits `available` and inserts an entry referencing `reserved`; a release does
  // the mirror image. Each entry insert's foreign-key check needs a key-share lock on the
  // other row, so the debit lock must not conflict with it.
  it("runs reserves and releases on one account in parallel without deadlocking", async () => {
    const userId = await createUser();
    await deposit(db, userId, "USD", 1_000n);
    await reserve(db, userId, "USD", 500n);

    // 20 of each, 10 at a time: neither bucket can run out in any order, so every one must
    // succeed.
    const outcomes = await Promise.allSettled(
      Array.from({ length: 40 }, (_, i) =>
        i % 2 === 0 ? reserve(db, userId, "USD", 10n) : release(db, userId, "USD", 10n),
      ),
    );

    // Drizzle wraps driver errors, so the Postgres SQLSTATE can sit on the cause.
    const failures = outcomes.flatMap((outcome) => {
      if (outcome.status === "fulfilled") {
        return [];
      }
      const reason = outcome.reason as { code?: string; cause?: { code?: string } };
      return [reason.code ?? reason.cause?.code ?? String(outcome.reason)];
    });
    expect(failures).toEqual([]);

    const usd = (await balancesOf(db, userId)).find((balance) => balance.asset === "USD");
    expect(usd).toMatchObject({ available: 500n, reserved: 500n });
    expect((usd?.available ?? 0n) + (usd?.reserved ?? 0n)).toBe(1_000n);
    // Each deadlock costs Postgres's 1s deadlock_timeout before it is detected, so a
    // regression needs room to report 40P01 instead of timing out.
  }, 30_000);
});
