// TEST HARNESS ONLY: starts the real API against two scratch databases
// (store A and store B) and gives tests a tiny HTTP client.
//
// Needs: TEST_DB_URL_A and TEST_DB_URL_B pointing at EMPTY throwaway
// databases (they are wiped!), and the test Prisma client generated with
//   npx prisma generate --schema tests/support/schema.test.prisma
import path from "path";
import { createRequire } from "module";
import type { AddressInfo } from "net";

export const DB_A = process.env.TEST_DB_URL_A ?? "";
export const DB_B = process.env.TEST_DB_URL_B ?? "";
export const hasDatabase = Boolean(DB_A && DB_B);

process.env.DATABASE_URL_STORE_A = DB_A || "postgresql://unused/a";
process.env.DATABASE_URL_STORE_B = DB_B || "postgresql://unused/b";
process.env.STORE_A_TAX_RATE = "8.875";
process.env.STORE_A_TAX_NAME = "NY Sales Tax";
process.env.STORE_B_TAX_RATE = "6.625";
process.env.JWT_SECRET = "test-secret-test-secret-test-secret-123456";
process.env.OWNER_EMAIL = "owner@test.local";
process.env.OWNER_PASSWORD = "correct-horse-battery";
process.env.OWNER_NAME = "Test Owner";

export async function startApi() {
  const require = createRequire(import.meta.url);
  const { PrismaClient } = require(path.join(process.cwd(), "node_modules/.prisma-test/client"));
  const { TestPgAdapterFactory, runSql } = await import("./pgAdapter.js");
  const { ddlFromDmmf } = await import("./ddl.js");
  const { setClientFactory, disconnectAll } = await import("../../src/db/stores.js");
  const { seedStore } = await import("../../scripts/seed.js");
  const { createApp } = await import("../../src/app.js");

  // Full datamodel dumped by tests/support/dmmf-generator.cjs
  const fs = await import("fs");
  const datamodel = JSON.parse(fs.readFileSync(path.join(process.cwd(), "tests/support/dmmf.json"), "utf8"));
  const ddl = ddlFromDmmf(datamodel);
  for (const url of [DB_A, DB_B]) {
    await runSql(url, "DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;");
    await runSql(url, ddl);
  }
  setClientFactory((url: string) => new PrismaClient({ adapter: new TestPgAdapterFactory(url) }));
  const log = console.log;
  console.log = () => {};
  await seedStore("A");
  await seedStore("B");
  console.log = log;

  const server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;

  async function call(
    method: string,
    url: string,
    opts: { body?: unknown; token?: string; store?: string } = {}
  ) {
    const res = await fetch(base + url, {
      method,
      headers: {
        "Content-Type": "application/json",
        "X-Store": opts.store ?? "A",
        ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    const type = res.headers.get("content-type") || "";
    const data = type.includes("json") ? await res.json() : await res.arrayBuffer();
    return { status: res.status, data: data as Any, type };
  }

  async function stop() {
    server.close();
    await disconnectAll();
  }
  return { call, stop, base };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
