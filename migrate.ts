// Applies every migration in ./drizzle that DATABASE_URL's database has not had yet, then
// exits. The API image runs it before the API starts. drizzle-kit is a dev dependency and the
// image installs runtime dependencies only, so this uses drizzle-orm's own migrator, which
// records what it applied in the same table `drizzle-kit migrate` does.

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client } from "pg";

const url = process.env.DATABASE_URL;
if (url === undefined) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

const client = new Client({ connectionString: url, connectionTimeoutMillis: 5000 });
try {
  await client.connect();
  await migrate(drizzle({ client }), { migrationsFolder: "./drizzle" });
  console.log("migrations applied");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await client.end();
}
