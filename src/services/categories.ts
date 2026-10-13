import type { Tx } from "../db/stores.js";
import { CATEGORIES } from "../domain/categories.js";

/** Adds any standard category this database doesn't have yet (matching names ignoring capitals). */
export async function ensureCategories(db: Tx) {
  const existing = await db.category.findMany({ select: { name: true, sortOrder: true } });
  const have = new Set(existing.map((c) => c.name.trim().toLowerCase()));
  let next = existing.reduce((m, c) => Math.max(m, c.sortOrder), 0) + 1;
  const added: string[] = [];
  for (const name of CATEGORIES) {
    if (have.has(name.toLowerCase())) continue;
    await db.category.create({ data: { name, sortOrder: next++ } });
    added.push(name);
  }
  return added;
}
