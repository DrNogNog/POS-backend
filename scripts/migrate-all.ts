// -----------------------------------------------------------------------------
// Applies database migrations to EVERY store database (Store A and Store B),
// so both always have the same tables.
//
//   npm run db:migrate        -> prisma migrate deploy on each store
// -----------------------------------------------------------------------------
import { execSync } from "child_process";
import { env } from "../src/config/env.js";

for (const store of env.stores) {
  console.log(`\n=== ${store.name} (store ${store.id}) ===`);
  execSync("npx prisma migrate deploy", {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: store.databaseUrl },
  });
}
console.log("\nAll store databases are up to date.");
