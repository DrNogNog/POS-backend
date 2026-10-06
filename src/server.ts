// Starts the POS API server. Configuration comes from .env (see .env.example).
import { createApp } from "./app.js";
import { env } from "./config/env.js";
import { describeDatabase, disconnectAll } from "./db/stores.js";

const app = createApp();

const server = app.listen(env.port, () => {
  console.log(`POS API running on http://localhost:${env.port}`);
  console.log(`Database: ${describeDatabase()} — this store's data is wherever PostgreSQL's data_directory points`);
});

async function shutdown() {
  server.close();
  await disconnectAll();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
