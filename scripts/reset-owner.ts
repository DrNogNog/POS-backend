// -----------------------------------------------------------------------------
// Can't log in as the owner? This sets the owner login to exactly what's in
// .env (OWNER_EMAIL / OWNER_PASSWORD / OWNER_NAME): it creates the account if
// it's missing, or resets its password, switches it back on and makes sure
// it has the OWNER role.
//
//   npm run owner:reset
//
// "npm run seed" only creates the owner the first time, so changing
// OWNER_PASSWORD in .env afterwards doesn't change an existing login — this does.
// -----------------------------------------------------------------------------
import bcrypt from "bcryptjs";
import { pathToFileURL } from "url";
import type { PrismaClient } from "@prisma/client";
import { describeDatabase, disconnectAll, getDb } from "../src/db/stores.js";

export async function resetOwner(db: PrismaClient): Promise<string> {
  const email = (process.env.OWNER_EMAIL || "").trim().toLowerCase();
  const password = process.env.OWNER_PASSWORD || "";
  const name = (process.env.OWNER_NAME || "").trim() || "Owner";
  if (!email || !password) throw new Error("Set OWNER_EMAIL and OWNER_PASSWORD in .env first.");
  if (password.length < 10) throw new Error("OWNER_PASSWORD must be at least 10 characters.");
  const hash = await bcrypt.hash(password, 12);
  const existing = await db.user.findUnique({ where: { email } });
  if (!existing) {
    await db.user.create({ data: { email, name, role: "OWNER", password: hash } });
    return `Owner login created: ${email}`;
  }
  await db.user.update({ where: { id: existing.id }, data: { password: hash, role: "OWNER", active: true } });
  return `Owner login reset from .env: ${email} (password updated${existing.active ? "" : ", switched back on"})`;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  console.log(`Database: ${describeDatabase()}`);
  resetOwner(getDb())
    .then((msg) => console.log(msg))
    .catch((e) => {
      console.error(e instanceof Error ? e.message : e);
      process.exitCode = 1;
    })
    .finally(disconnectAll);
}
