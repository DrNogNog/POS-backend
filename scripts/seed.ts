// -----------------------------------------------------------------------------
// Sets up a store database with the basics. Safe to run more than once.
//
//   npm run seed            -> seeds every store in .env
//   npm run seed -- A       -> seeds only Store A
//
// Creates: store settings, chart of accounts, price tiers AA-D, product
// categories, a default sales tax rate, and the OWNER login from .env.
// -----------------------------------------------------------------------------
import bcrypt from "bcryptjs";
import { pathToFileURL } from "url";
import { env, type StoreId } from "../src/config/env.js";
import { getDb, disconnectAll } from "../src/db/stores.js";
import { CHART_OF_ACCOUNTS } from "../src/domain/accounts.js";

const PRICE_TIERS = [
  { code: "AA", name: "Cost (no markup)", markupPct: 0, sortOrder: 0, description: "Internal / at cost" },
  { code: "A", name: "Level A", markupPct: 50, sortOrder: 1, description: "Best contractor price" },
  { code: "B", name: "Level B", markupPct: 60, sortOrder: 2, description: "" },
  { code: "C", name: "Level C", markupPct: 70, sortOrder: 3, description: "" },
  { code: "D", name: "Level D", markupPct: 80, sortOrder: 4, description: "Retail" },
];

const CATEGORIES = [
  "Cabinets",
  "Countertops",
  "Fasteners",
  "Safety Equipment",
  "Sundries",
  "Tools & Accessories",
  "Electrical",
  "Locks & Security",
  "Lawn & Garden",
  "Hardware & Houseware",
];

export async function seedStore(storeId: StoreId) {
  const store = env.stores.find((s) => s.id === storeId)!;
  const db = getDb(storeId);
  console.log(`\nSeeding ${store.name} (store ${storeId})...`);

  await db.storeSettings.upsert({ where: { id: 1 }, create: { id: 1, name: store.name }, update: {} });

  for (const a of CHART_OF_ACCOUNTS) {
    await db.account.upsert({
      where: { code: a.code },
      create: { code: a.code, name: a.name, type: a.type, isCurrent: a.isCurrent ?? true },
      update: { name: a.name, type: a.type, isCurrent: a.isCurrent ?? true },
    });
  }
  for (const t of PRICE_TIERS) {
    await db.priceTier.upsert({ where: { code: t.code }, create: t, update: {} });
  }
  for (const [i, name] of CATEGORIES.entries()) {
    await db.category.upsert({ where: { name }, create: { name, sortOrder: i }, update: {} });
  }

  const taxName = process.env[`STORE_${storeId}_TAX_NAME`] || "Sales tax";
  const taxRate = Number(process.env[`STORE_${storeId}_TAX_RATE`] || 0);
  if ((await db.taxRate.count()) === 0) {
    await db.taxRate.create({ data: { name: taxName, ratePct: taxRate, isDefault: true } });
    await db.taxRate.create({ data: { name: "Tax exempt", ratePct: 0 } });
  }

  const email = (process.env.OWNER_EMAIL || "").trim().toLowerCase();
  const password = process.env.OWNER_PASSWORD || "";
  if (email && password) {
    if (password.length < 10) throw new Error("OWNER_PASSWORD must be at least 10 characters");
    const existing = await db.user.findUnique({ where: { email } });
    if (!existing) {
      await db.user.create({
        data: {
          email,
          name: process.env.OWNER_NAME || "Owner",
          role: "OWNER",
          password: await bcrypt.hash(password, 12),
        },
      });
      console.log(`  Owner login created: ${email}`);
    } else {
      console.log(`  Owner login already exists: ${email}`);
    }
  } else {
    console.log("  (Set OWNER_EMAIL and OWNER_PASSWORD in .env to create the first login.)");
  }
  console.log("  Done.");
}

async function main() {
  const only = process.argv[2]?.toUpperCase();
  const targets = env.stores.filter((s) => !only || s.id === only).map((s) => s.id);
  if (targets.length === 0) throw new Error(`No store "${only}" in .env`);
  for (const id of targets) await seedStore(id);
}

// Run only when called from the command line (not when imported by tests)
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main()
    .catch((e) => {
      console.error(e instanceof Error ? e.message : e);
      process.exitCode = 1;
    })
    .finally(disconnectAll);
}
