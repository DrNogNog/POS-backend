// -----------------------------------------------------------------------------
// Applies database migrations to the POS database (DATABASE_URL).
//
//   npm run db:migrate
//
// Run it with each store's drive in place (PostgreSQL's data_directory
// pointing at that drive) so every drive gets the same tables.
// -----------------------------------------------------------------------------
import { execSync } from "child_process";
import { env } from "../src/config/env.js";
import { describeDatabase } from "../src/db/stores.js";

console.log(`Migrating ${describeDatabase()} ...`);
execSync("npx prisma migrate deploy", {
  stdio: "inherit",
  env: { ...process.env, DATABASE_URL: env.databaseUrl },
});
console.log("Database is up to date.");
