import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { balancesOf, deposit, LedgerError, openAccount, postTransaction } from "./ledger.ts";
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

    await expect(entriesOf(available, 2)).resolves.toEqual([]);
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
      { asset: "USD", scale: 2, available: 0n, reserved: 0n },
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
