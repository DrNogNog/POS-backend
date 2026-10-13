// Starts the POS API server. Configuration comes from .env (see .env.example).
import { createApp } from "./app.js";
import { env } from "./config/env.js";
import { describeDatabase, disconnectAll, getDb } from "./db/stores.js";
import { syncWorkerLogin } from "./services/workerLogin.js";
import { ensureChartOfAccounts } from "./services/journal.js";
import { ensureCategories } from "./services/categories.js";

const app = createApp();

const server = app.listen(env.port, () => {
  console.log(`POS API running on http://localhost:${env.port}`);
  console.log(`Database: ${describeDatabase()} — this store's data is wherever PostgreSQL's data_directory points`);
  // Accounts the books need, added if this database is missing any
  ensureChartOfAccounts(getDb())
    .then((n) => n && console.log(`Added ${n} missing account${n === 1 ? "" : "s"} to the chart of accounts`))
    .catch((e) => console.error(`Chart of accounts check failed: ${e instanceof Error ? e.message : e}`));
  // Standard item categories (Paint, Nails, Brushes, Plumbing, ...) added if missing
  ensureCategories(getDb())
    .then((added) => added.length && console.log(`Added categories: ${added.join(", ")}`))
    .catch((e) => console.error(`Category check failed: ${e instanceof Error ? e.message : e}`));
  // The worker login is kept in step with WORKER_* in .env
  syncWorkerLogin(getDb())
    .then((msg) => console.log(msg))
    .catch((e) => console.error(`Worker login not set up: ${e instanceof Error ? e.message : e}`));
});

async function shutdown() {
  server.close();
  await disconnectAll();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
