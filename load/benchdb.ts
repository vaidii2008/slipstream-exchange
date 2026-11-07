// The load test's own database, slipstream_bench, beside the dev one on the same Postgres. A
// run logs hundreds of thousands of commands, so it gets a database that is created for the
// run and dropped afterwards, and the dev event log never replays them.
//
//   node load/benchdb.ts create   creates and migrates it, then prints its URL
//   node load/benchdb.ts pad      gives every bench user a long ledger history (see below)
//   node load/benchdb.ts drop     drops it, disconnecting anything still attached

import { existsSync } from "node:fs";
import { Client } from "pg";
import { createAndMigrate } from "../testdb.ts";

if (existsSync(".env")) {
  process.loadEnvFile(".env");
}
const devUrl = process.env.DATABASE_URL;
if (devUrl === undefined) {
  throw new Error("DATABASE_URL is not set: add it to .env");
}
// Derived like slipstream_test's, so the bench can never be pointed at the dev database.
const benchUrl = new URL(devUrl);
benchUrl.pathname = `${benchUrl.pathname}_bench`;
const name = benchUrl.pathname.slice(1);

// 1,000 reserve and release pairs per bench user per asset: about 2,000 entries on each of
// their accounts. Every padded account nets to zero, so the cached balances are still right
// although these entries bypass postTransaction. Run after a k6 run's setup has
// registered and funded the users. Entries are written round by round across all accounts,
// so one account's entries sit far apart on disk, as in a history many users built at once.
// Written next to each other instead, a sum reads a few pages and the cost is understated.
const PAD = `
  insert into ledger_accounts (user_id, asset, bucket)
    select u.id, a.code, 'reserved' from users u cross join assets a
    where u.email like 'bench-%' on conflict do nothing;
  create temporary table pad on commit drop as
    select row_number() over (order by g, av.id)
             + (select coalesce(max(id), 0) from ledger_transactions) as tx_id,
           av.id as avail, rs.id as res, g, a.scale
    from ledger_accounts av
    join ledger_accounts rs
      on rs.user_id = av.user_id and rs.asset = av.asset and rs.bucket = 'reserved'
    join assets a on a.code = av.asset
    join users u on u.id = av.user_id
    cross join generate_series(1, 2000) g
    where av.bucket = 'available' and u.email like 'bench-%';
  insert into ledger_transactions (id, kind) overriding system value
    select tx_id, (case when g % 2 = 1 then 'reserve' else 'release' end)::ledger_transaction_kind
    from pad order by tx_id;
  select setval(pg_get_serial_sequence('ledger_transactions', 'id'),
                (select max(id) from ledger_transactions));
  insert into ledger_entries (transaction_id, account_id, amount)
    select tx_id, account_id, amount from (
      select tx_id, 0 as leg, avail as account_id,
             (case when g % 2 = 1 then -1 else 1 end) * power(10::numeric, -scale) as amount
      from pad
      union all
      select tx_id, 1, res,
             (case when g % 2 = 1 then 1 else -1 end) * power(10::numeric, -scale)
      from pad
    ) legs order by tx_id, leg;
`;

const action = process.argv[2];
if (action === "create") {
  await createAndMigrate(devUrl, benchUrl.toString());
  console.log(benchUrl.toString());
} else if (action === "pad") {
  const bench = new Client({ connectionString: benchUrl.toString() });
  await bench.connect();
  try {
    // One transaction: a failed pad leaves the database as it was.
    await bench.query("begin");
    await bench.query(PAD);
    await bench.query("commit");
    await bench.query("vacuum analyze");
    const { rows } = await bench.query<{ entries: string }>(
      "select count(*)::text as entries from ledger_entries",
    );
    console.log(`${name} now holds ${rows[0]?.entries} ledger entries`);
  } catch (error) {
    await bench.query("rollback");
    throw error;
  } finally {
    await bench.end();
  }
} else if (action === "drop") {
  const admin = new Client({ connectionString: devUrl });
  await admin.connect();
  try {
    // A name cannot be a bind parameter; it comes from our own DATABASE_URL, quoted.
    await admin.query(`drop database if exists "${name.replaceAll('"', '""')}" with (force)`);
    console.log(`dropped ${name}`);
  } finally {
    await admin.end();
  }
} else {
  throw new Error("usage: node load/benchdb.ts create|pad|drop");
}
