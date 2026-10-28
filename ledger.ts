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

export type LedgerErrorCode = "too_few_postings" | "zero_amount" | "unknown_account" | "unbalanced";

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
      .select({ id: ledgerAccounts.id, asset: ledgerAccounts.asset, scale: assets.scale })
      .from(ledgerAccounts)
      .innerJoin(assets, eq(assets.code, ledgerAccounts.asset))
      .where(inArray(ledgerAccounts.id, accountIds));
    const accountsById = new Map(accounts.map((account) => [account.id, account]));

    const totals = new Map<string, bigint>();
    const rows = postings.map((posting) => {
      const account = accountsById.get(posting.accountId);
      if (account === undefined) {
        throw new LedgerError("unknown_account", `no ledger account ${posting.accountId}`);
      }
      totals.set(account.asset, (totals.get(account.asset) ?? 0n) + posting.amount);
      return { accountId: posting.accountId, amount: formatAmount(posting.amount, account.scale) };
    });

    for (const [asset, total] of totals) {
      if (total !== 0n) {
        throw new LedgerError("unbalanced", `${asset} entries sum to ${total}, not zero`);
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
