import { and, eq, inArray, isNull, sum } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { formatAmount, fromNumeric } from "./money.ts";
import { assets, ledgerAccounts, ledgerEntries, ledgerTransactions } from "./schema.ts";

export type Bucket = (typeof ledgerAccounts.bucket.enumValues)[number];
export type TransactionKind = (typeof ledgerTransactions.kind.enumValues)[number];

// One side of a transaction: a signed amount in the account's asset's minor units.
export type Posting = {
  accountId: number;
  amount: bigint;
};

export type LedgerErrorCode =
  "too_few_postings" | "zero_amount" | "unknown_account" | "unbalanced" | "insufficient_funds";

export class LedgerError extends Error {
  readonly code: LedgerErrorCode;

  constructor(code: LedgerErrorCode, message: string) {
    super(message);
    this.name = "LedgerError";
    this.code = code;
  }
}

// Accounts are created the first time they are needed, so a new user has no rows until money
// moves. `owner` null is the asset's system account.
export async function openAccount(
  db: NodePgDatabase,
  owner: string | null,
  asset: string,
  bucket: Bucket,
): Promise<number> {
  const matches = and(
    owner === null ? isNull(ledgerAccounts.userId) : eq(ledgerAccounts.userId, owner),
    eq(ledgerAccounts.asset, asset),
    eq(ledgerAccounts.bucket, bucket),
  );

  const [existing] = await db
    .select({ id: ledgerAccounts.id })
    .from(ledgerAccounts)
    .where(matches)
    .limit(1);
  if (existing !== undefined) {
    return existing.id;
  }

  const [created] = await db
    .insert(ledgerAccounts)
    .values({ userId: owner, asset, bucket })
    .onConflictDoNothing({
      target: [ledgerAccounts.userId, ledgerAccounts.asset, ledgerAccounts.bucket],
    })
    .returning({ id: ledgerAccounts.id });
  if (created !== undefined) {
    return created.id;
  }

  // A concurrent call inserted the same account between our select and insert.
  const [raced] = await db
    .select({ id: ledgerAccounts.id })
    .from(ledgerAccounts)
    .where(matches)
    .limit(1);
  if (raced === undefined) {
    throw new Error(`ledger account for ${owner ?? "system"} ${asset} ${bucket} vanished`);
  }
  return raced.id;
}

// Writes one transaction and all its entries, or nothing. The asset of each posting comes
// from the database, not the caller, so a caller cannot balance BTC against USD by mislabelling.
export async function postTransaction(
  db: NodePgDatabase,
  kind: TransactionKind,
  postings: Posting[],
): Promise<number> {
  if (postings.length < 2) {
    throw new LedgerError("too_few_postings", "a transaction needs at least two postings");
  }
  if (postings.some((posting) => posting.amount === 0n)) {
    throw new LedgerError("zero_amount", "a posting cannot move zero");
  }

  return db.transaction(async (tx) => {
    const accountIds = [...new Set(postings.map((posting) => posting.accountId))];
    const accounts = await tx
      .select({
        id: ledgerAccounts.id,
        userId: ledgerAccounts.userId,
        asset: ledgerAccounts.asset,
        scale: assets.scale,
      })
      .from(ledgerAccounts)
      .innerJoin(assets, eq(assets.code, ledgerAccounts.asset))
      .where(inArray(ledgerAccounts.id, accountIds));
    const accountsById = new Map(accounts.map((account) => [account.id, account]));

    const totals = new Map<string, bigint>();
    const netChange = new Map<number, bigint>();
    const rows = postings.map((posting) => {
      const account = accountsById.get(posting.accountId);
      if (account === undefined) {
        throw new LedgerError("unknown_account", `no ledger account ${posting.accountId}`);
      }
      totals.set(account.asset, (totals.get(account.asset) ?? 0n) + posting.amount);
      netChange.set(account.id, (netChange.get(account.id) ?? 0n) + posting.amount);
      return { accountId: posting.accountId, amount: formatAmount(posting.amount, account.scale) };
    });

    for (const [asset, total] of totals) {
      if (total !== 0n) {
        throw new LedgerError("unbalanced", `${asset} entries sum to ${total}, not zero`);
      }
    }

    // Only a user account that loses money can be overdrawn, so only those are locked and
    // checked. The system account may go negative, and skipping it keeps every deposit of an
    // asset from queueing on one row.
    const debited = [...netChange]
      .filter(([id, change]) => change < 0n && accountsById.get(id)?.userId !== null)
      .map(([id]) => id);

    if (debited.length > 0) {
      // Locks are always taken in ascending id order, whatever order the postings came in, so
      // two transactions debiting the same accounts queue instead of deadlocking.
      await tx
        .select({ id: ledgerAccounts.id })
        .from(ledgerAccounts)
        .where(inArray(ledgerAccounts.id, debited))
        .orderBy(ledgerAccounts.id)
        .for("update");

      // A new statement after the lock, so under READ COMMITTED it sees every entry committed
      // by whoever held the lock before us.
      const sums = await tx
        .select({ accountId: ledgerEntries.accountId, total: sum(ledgerEntries.amount) })
        .from(ledgerEntries)
        .where(inArray(ledgerEntries.accountId, debited))
        .groupBy(ledgerEntries.accountId);
      const balanceOf = new Map(sums.map((row) => [row.accountId, row.total ?? "0"]));

      for (const id of debited) {
        const account = accountsById.get(id);
        const change = netChange.get(id);
        if (account === undefined || change === undefined) {
          throw new Error(`debited account ${id} missing from its own lookup`);
        }
        const balance = fromNumeric(balanceOf.get(id) ?? "0", account.scale);
        if (balance + change < 0n) {
          throw new LedgerError(
            "insufficient_funds",
            `account ${id} holds ${balance} ${account.asset}, cannot take ${-change}`,
          );
        }
      }
    }

    const [transaction] = await tx
      .insert(ledgerTransactions)
      .values({ kind })
      .returning({ id: ledgerTransactions.id });
    if (transaction === undefined) {
      throw new Error("ledger transaction insert returned no row");
    }

    await tx
      .insert(ledgerEntries)
      .values(rows.map((row) => ({ ...row, transactionId: transaction.id })));

    return transaction.id;
  });
}

// Simulated: money arrives from the asset's system account, which goes negative by exactly
// what has been deposited in total.
export async function deposit(
  db: NodePgDatabase,
  userId: string,
  asset: string,
  amount: bigint,
): Promise<number> {
  if (amount <= 0n) {
    throw new RangeError(`deposit amount must be positive, got ${amount}`);
  }
  const system = await openAccount(db, null, asset, "available");
  const available = await openAccount(db, userId, asset, "available");

  return postTransaction(db, "deposit", [
    { accountId: system, amount: -amount },
    { accountId: available, amount },
  ]);
}

// Moves funds from available to reserved, for an open order. Fails with insufficient_funds
// rather than overdraw.
export function reserve(
  db: NodePgDatabase,
  userId: string,
  asset: string,
  amount: bigint,
): Promise<number> {
  return moveBetweenBuckets(db, "reserve", userId, asset, "available", "reserved", amount);
}

// Moves funds from reserved back to available, for a cancelled or finished order.
export function release(
  db: NodePgDatabase,
  userId: string,
  asset: string,
  amount: bigint,
): Promise<number> {
  return moveBetweenBuckets(db, "release", userId, asset, "reserved", "available", amount);
}

async function moveBetweenBuckets(
  db: NodePgDatabase,
  kind: TransactionKind,
  userId: string,
  asset: string,
  from: Bucket,
  to: Bucket,
  amount: bigint,
): Promise<number> {
  if (amount <= 0n) {
    throw new RangeError(`${kind} amount must be positive, got ${amount}`);
  }
  const source = await openAccount(db, userId, asset, from);
  const destination = await openAccount(db, userId, asset, to);

  return postTransaction(db, kind, [
    { accountId: source, amount: -amount },
    { accountId: destination, amount },
  ]);
}

export type Balance = {
  asset: string;
  scale: number;
  available: bigint;
  reserved: bigint;
};

// Every listed asset, zero where the user has no entries. Summed from the entries on every
// read; there is no stored balance that could drift from them.
export async function balancesOf(db: NodePgDatabase, userId: string): Promise<Balance[]> {
  const rows = await db
    .select({
      asset: assets.code,
      scale: assets.scale,
      bucket: ledgerAccounts.bucket,
      total: sum(ledgerEntries.amount),
    })
    .from(assets)
    .leftJoin(
      ledgerAccounts,
      and(eq(ledgerAccounts.asset, assets.code), eq(ledgerAccounts.userId, userId)),
    )
    .leftJoin(ledgerEntries, eq(ledgerEntries.accountId, ledgerAccounts.id))
    .groupBy(assets.code, assets.scale, ledgerAccounts.bucket)
    .orderBy(assets.code);

  const balances = new Map<string, Balance>();
  for (const row of rows) {
    const balance = balances.get(row.asset) ?? {
      asset: row.asset,
      scale: row.scale,
      available: 0n,
      reserved: 0n,
    };
    if (row.bucket !== null && row.total !== null) {
      balance[row.bucket] = fromNumeric(row.total, row.scale);
    }
    balances.set(row.asset, balance);
  }
  return [...balances.values()];
}
