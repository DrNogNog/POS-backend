// -----------------------------------------------------------------------------
// Sets up the database with the basics. Safe to run more than once.
//
//   npm run seed
//
// Run it once per store drive: point PostgreSQL's data_directory at that
// drive, then seed. STORE_NAME / TAX_NAME / TAX_RATE in .env are only used
// the first time — after that, change them on the Settings screen.
//
// Creates: store settings, chart of accounts, price tiers AA-D, product
// categories, a default sales tax rate, and the OWNER login from .env.
// -----------------------------------------------------------------------------
import bcrypt from "bcryptjs";
import { pathToFileURL } from "url";
import { describeDatabase, getDb, disconnectAll } from "../src/db/stores.js";
import { syncWorkerLogin } from "../src/services/workerLogin.js";
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

export async function seedStore() {
  const db = getDb();
  const storeName = process.env.STORE_NAME || process.env.STORE_A_NAME || "Champion";
  console.log(`\nSeeding ${describeDatabase()} ...`);

  await db.storeSettings.upsert({ where: { id: 1 }, create: { id: 1, name: storeName }, update: {} });

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

  const taxName = process.env.TAX_NAME || process.env.STORE_A_TAX_NAME || "Sales tax";
  const taxRate = Number(process.env.TAX_RATE || process.env.STORE_A_TAX_RATE || 0);
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
  console.log(`  ${await syncWorkerLogin(db)}`);
  console.log("  Done.");
}

async function main() {
  await seedStore();
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
