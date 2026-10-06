// -----------------------------------------------------------------------------
// Imports a price list CSV into the catalog (no stock is added).
//
//   npm run import:pricelist -- A data/pricelist-2025.csv
//
// CSV columns: itemCode,name,description,category,collection,supplier,
//              listPrice,supplierDiscountPct,unitCost,unit
// Existing item codes are UPDATED (prices, names); new ones are created.
// -----------------------------------------------------------------------------
import fs from "fs";
import { getDb, disconnectAll } from "../src/db/stores.js";

function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((f) => f !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const [header, ...data] = rows;
  return data.map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), (r[i] ?? "").trim()])));
}

async function main() {
  const file = process.argv[2] || "data/pricelist-2025.csv";
  const db = getDb();
  const rows = parseCsv(fs.readFileSync(file, "utf8"));
  console.log(`Importing ${rows.length} items from ${file}...`);

  const catIds = new Map<string, number>();
  const supIds = new Map<string, number>();
  for (const r of rows) {
    if (r.category && !catIds.has(r.category)) {
      const c = await db.category.upsert({ where: { name: r.category }, create: { name: r.category }, update: {} });
      catIds.set(r.category, c.id);
    }
    if (r.supplier && !supIds.has(r.supplier)) {
      const s = await db.supplier.upsert({ where: { name: r.supplier }, create: { name: r.supplier }, update: {} });
      supIds.set(r.supplier, s.id);
    }
  }

  let created = 0;
  let updated = 0;
  for (const r of rows) {
    const itemCode = r.itemCode.toUpperCase();
    const listPrice = Number(r.listPrice) || 0;
    const discount = Number(r.supplierDiscountPct) || 0;
    const unitCost = r.unitCost ? Number(r.unitCost) : Math.round(listPrice * (1 - discount / 100) * 10000) / 10000;
    const data = {
      name: r.name || itemCode,
      description: r.description || "",
      collection: r.collection || "",
      unit: r.unit || "each",
      listPrice,
      supplierDiscountPct: discount,
      unitCost,
      categoryId: catIds.get(r.category) ?? null,
      supplierId: supIds.get(r.supplier) ?? null,
    };
    const existing = await db.product.findUnique({ where: { itemCode } });
    if (existing) {
      await db.product.update({ where: { id: existing.id }, data });
      updated++;
    } else {
      await db.product.create({ data: { itemCode, ...data } });
      created++;
    }
  }
  await db.activityLog.create({
    data: {
      entityType: "Product",
      action: "IMPORTED",
      summary: `Price list ${file} imported: ${created} new, ${updated} updated`,
      userName: "import script",
    },
  });
  console.log(`Done: ${created} created, ${updated} updated.`);
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(disconnectAll);
