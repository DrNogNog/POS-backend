// -----------------------------------------------------------------------------
// Fallback for "npm run db:migrate" when Windows (antivirus, security
// software) won't let Prisma run its schema-engine program.
//
//   npm run db:migrate:direct
//
// Applies the same prisma/migrations/*/migration.sql files through the normal
// database connection the app already uses, and records them in Prisma's
// "_prisma_migrations" table exactly like "prisma migrate deploy" does — so
// later, when "npm run db:migrate" works again, it sees them as done.
// Safe to run more than once: migrations already applied are skipped.
// -----------------------------------------------------------------------------
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { pathToFileURL } from "url";
import type { PrismaClient } from "@prisma/client";
import { describeDatabase, disconnectAll, getDb } from "../src/db/stores.js";

const MIGRATIONS_DIR = path.join(process.cwd(), "prisma", "migrations");

/** Splits a migration file into single statements (the connection runs one at a time). */
export function splitStatements(sql: string): string[] {
  const withoutComments = sql
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
  return withoutComments
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function applyMigrations(db: PrismaClient, log: (msg: string) => void = console.log) {
  // Same table "prisma migrate deploy" keeps
  await db.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
      "id" VARCHAR(36) PRIMARY KEY NOT NULL,
      "checksum" VARCHAR(64) NOT NULL,
      "finished_at" TIMESTAMPTZ,
      "migration_name" VARCHAR(255) NOT NULL,
      "logs" TEXT,
      "rolled_back_at" TIMESTAMPTZ,
      "started_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
      "applied_steps_count" INTEGER NOT NULL DEFAULT 0
    )`);
  const done = new Set(
    (
      await db.$queryRawUnsafe<{ migration_name: string }[]>(
        `SELECT "migration_name" FROM "_prisma_migrations" WHERE "finished_at" IS NOT NULL AND "rolled_back_at" IS NULL`
      )
    ).map((r) => r.migration_name)
  );
  const names = fs
    .readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(MIGRATIONS_DIR, d.name, "migration.sql")))
    .map((d) => d.name)
    .sort();

  let applied = 0;
  for (const name of names) {
    if (done.has(name)) {
      log(`  already applied  ${name}`);
      continue;
    }
    const file = fs.readFileSync(path.join(MIGRATIONS_DIR, name, "migration.sql"));
    const checksum = crypto.createHash("sha256").update(file).digest("hex");
    const id = crypto.randomUUID();
    await db.$executeRawUnsafe(
      `INSERT INTO "_prisma_migrations" ("id", "checksum", "migration_name", "started_at", "applied_steps_count") VALUES ($1, $2, $3, now(), 0)`,
      id,
      checksum,
      name
    );
    try {
      for (const statement of splitStatements(file.toString("utf8"))) {
        await db.$executeRawUnsafe(statement);
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await db.$executeRawUnsafe(`UPDATE "_prisma_migrations" SET "logs" = $1 WHERE "id" = $2`, message, id);
      throw new Error(`Migration ${name} failed: ${message}`);
    }
    await db.$executeRawUnsafe(
      `UPDATE "_prisma_migrations" SET "finished_at" = now(), "applied_steps_count" = 1 WHERE "id" = $1`,
      id
    );
    log(`  applied          ${name}`);
    applied++;
  }
  return applied;
}

async function main() {
  console.log(`Migrating ${describeDatabase()} (direct) ...`);
  const applied = await applyMigrations(getDb());
  console.log(applied ? `Done: ${applied} migration(s) applied. Next: npm run db:generate, then npm run seed.` : "Database is already up to date.");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main()
    .catch((e) => {
      console.error(e instanceof Error ? e.message : e);
      process.exitCode = 1;
    })
    .finally(disconnectAll);
}
