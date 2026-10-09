// -----------------------------------------------------------------------------
// The worker login comes from .env — it is not created on the Settings screen.
//
//   WORKER_NAME="Shop Worker"
//   WORKER_EMAIL="worker@example.com"
//   WORKER_PASSWORD="at-least-8-characters"
//
// Every time the server starts (and on "npm run seed") this makes the
// database match .env: the account is created or updated with that name and
// password, and any other worker account is switched off. Remove the lines
// from .env and the worker can no longer log in.
// -----------------------------------------------------------------------------
import bcrypt from "bcryptjs";
import type { Db } from "../db/stores.js";

export function workerFromEnv() {
  const email = (process.env.WORKER_EMAIL || "").trim().toLowerCase();
  const password = process.env.WORKER_PASSWORD || "";
  const name = (process.env.WORKER_NAME || "").trim() || "Worker";
  return email && password ? { email, password, name } : null;
}

export async function syncWorkerLogin(db: Db): Promise<string> {
  const w = workerFromEnv();
  if (w && w.password.length < 8) throw new Error("WORKER_PASSWORD must be at least 8 characters");

  // Only the .env worker may log in as a worker
  const others = await db.user.updateMany({
    where: { role: "WORKER", active: true, ...(w ? { email: { not: w.email } } : {}) },
    data: { active: false },
  });
  if (!w) return others.count ? `Worker login: none in .env (${others.count} switched off)` : "Worker login: none in .env";

  const existing = await db.user.findUnique({ where: { email: w.email } });
  if (existing && existing.role !== "WORKER") {
    throw new Error(`WORKER_EMAIL ${w.email} already belongs to a ${existing.role.toLowerCase()} login — use a different email.`);
  }
  if (!existing) {
    await db.user.create({ data: { email: w.email, name: w.name, role: "WORKER", password: await bcrypt.hash(w.password, 12) } });
    return `Worker login created: ${w.email}`;
  }
  const samePassword = await bcrypt.compare(w.password, existing.password);
  if (samePassword && existing.name === w.name && existing.active) return `Worker login: ${w.email}`;
  await db.user.update({
    where: { id: existing.id },
    data: {
      name: w.name,
      active: true,
      ...(samePassword ? {} : { password: await bcrypt.hash(w.password, 12) }),
    },
  });
  return `Worker login updated from .env: ${w.email}`;
}
