import { and, eq, inArray, isNull, max, sql, sum } from "drizzle-orm";
import type { NodePgQueryResultHKT } from "drizzle-orm/node-postgres";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { formatAmount, fromNumeric } from "./money.ts";
import { assets, ledgerAccounts, ledgerEntries, ledgerTransactions } from "./schema.ts";

// The pool-backed database or a transaction already open on it. Every ledger function takes
// either, so a caller can reserve funds and write its own rows in one commit. Inside an open
// transaction, postTransaction's own transaction becomes a savepoint.
export type Database = PgDatabase<NodePgQueryResultHKT>;

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
  db: Database,
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

export type LockedAccount = {
  id: number;
  userId: string | null;
  asset: string;
  scale: number;
  // The cached balance as of the lock, at the asset's scale.
  balance: bigint;
};

// Locks accounts that are about to change, until the enclosing transaction ends, and returns
// each one's cached balance as it stands once locked. Every account a transaction touches is
// locked, debited or credited: updating the cached balance takes the row's lock anyway, and
// taking it here, all at once, keeps the order under our control. Locks are taken in
// ascending id order, whatever order the caller lists them in, so two transactions touching
// the same accounts queue instead of deadlocking. A caller about to post several transactions
// in one commit locks the union first: posting them one by one would take each one's locks in
// turn, and two such callers could take them in opposite orders. Locking an account this
// transaction already holds returns at once.
//
// NO KEY UPDATE, not UPDATE: inserting an entry makes Postgres take FOR KEY SHARE on the
// account it references, for the foreign-key check, and FOR UPDATE blocks that. NO KEY UPDATE
// is also the lock the balance update itself takes, and it conflicts with itself, so two
// transactions changing one account still queue.
//
// The row is read by the locking statement itself. Under READ COMMITTED a row lock that had
// to wait returns the row as the previous holder committed it, so the balance is current.
export async function lockAccounts(db: Database, accountIds: number[]): Promise<LockedAccount[]> {
  if (accountIds.length === 0) {
    return [];
  }
  const rows = await db
    .select({
      id: ledgerAccounts.id,
      userId: ledgerAccounts.userId,
      asset: ledgerAccounts.asset,
      scale: assets.scale,
      balance: ledgerAccounts.balance,
    })
    .from(ledgerAccounts)
    .innerJoin(assets, eq(assets.code, ledgerAccounts.asset))
    .where(inArray(ledgerAccounts.id, accountIds))
    .orderBy(ledgerAccounts.id)
    .for("no key update", { of: ledgerAccounts });
  return rows.map((row) => ({ ...row, balance: fromNumeric(row.balance, row.scale) }));
}

// Writes one transaction and all its entries, and moves each account's cached balance by its
// entries, or does nothing. The asset of each posting comes from the database, not the caller,
// so a caller cannot balance BTC against USD by mislabelling.
export async function postTransaction(
  db: Database,
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
    // Every account the postings name, the system account included. A deposit therefore
    // queues on its asset's system account; deposits are rare next to orders, and leaving
    // that one row out would make its cached balance the one that is not its entries' sum.
    const accounts = await lockAccounts(tx, [
      ...new Set(postings.map((posting) => posting.accountId)),
    ]);
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

    // Only a user account that loses money can be overdrawn. The system account may go
    // negative: it is minus everything ever deposited.
    const changes: { account: LockedAccount; change: bigint }[] = [];
    for (const [id, change] of netChange) {
      const account = accountsById.get(id);
      if (account === undefined) {
        throw new Error(`posted account ${id} missing from its own lookup`);
      }
      if (account.userId !== null && account.balance + change < 0n) {
        throw new LedgerError(
          "insufficient_funds",
          `account ${id} holds ${account.balance} ${account.asset}, cannot take ${-change}`,
        );
      }
      if (change !== 0n) {
        changes.push({ account, change });
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

    // One statement for every account, relative to the stored value rather than the one read
    // under the lock, so it is right even if this transaction already moved the account.
    if (changes.length > 0) {
      const values = changes.map(
        ({ account, change }) =>
          sql`(${account.id}::bigint, ${formatAmount(change, account.scale)}::numeric)`,
      );
      await tx.execute(sql`
        update ${ledgerAccounts} set balance = ${ledgerAccounts.balance} + v.change
        from (values ${sql.join(values, sql`, `)}) as v(id, change)
        where ${ledgerAccounts.id} = v.id`);
    }

    return transaction.id;
  });
}

// Simulated: money arrives from the asset's system account, which goes negative by exactly
// what has been deposited in total.
export async function deposit(
  db: Database,
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
  db: Database,
  userId: string,
  asset: string,
  amount: bigint,
): Promise<number> {
  return moveBetweenBuckets(db, "reserve", userId, asset, "available", "reserved", amount);
}

// Moves funds from reserved back to available, for a cancelled or finished order.
export function release(
  db: Database,
  userId: string,
  asset: string,
  amount: bigint,
): Promise<number> {
  return moveBetweenBuckets(db, "release", userId, asset, "reserved", "available", amount);
}

async function moveBetweenBuckets(
  db: Database,
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

// Every listed asset, zero where the user has no entries. Summed from the entries, the source
// of truth, not read from the cached balance: a read takes no lock and is off the order path,
// and accountState's version needs the entries anyway.
export async function balancesOf(db: Database, userId: string): Promise<Balance[]> {
  return (await accountState(db, userId)).balances;
}

// Balances with a version: the highest ledger entry id they include, 0 before any. Entry ids
// only grow, so of two reads the one with the higher version saw at least everything the
// other did. Both come from one statement, so they always describe the same moment.
export async function accountState(
  db: Database,
  userId: string,
): Promise<{ version: number; balances: Balance[] }> {
  const rows = await db
    .select({
      asset: assets.code,
      scale: assets.scale,
      bucket: ledgerAccounts.bucket,
      total: sum(ledgerEntries.amount),
      lastEntry: max(ledgerEntries.id),
    })
    .from(assets)
    .leftJoin(
      ledgerAccounts,
      and(eq(ledgerAccounts.asset, assets.code), eq(ledgerAccounts.userId, userId)),
    )
    .leftJoin(ledgerEntries, eq(ledgerEntries.accountId, ledgerAccounts.id))
    .groupBy(assets.code, assets.scale, ledgerAccounts.bucket)
    .orderBy(assets.code);

  let version = 0;
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
    if (row.lastEntry !== null && row.lastEntry > version) {
      version = row.lastEntry;
    }
    balances.set(row.asset, balance);
  }
  return { version, balances: [...balances.values()] };
}
