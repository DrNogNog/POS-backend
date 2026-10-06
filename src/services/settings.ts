// -----------------------------------------------------------------------------
// Store settings, tax rates and price tiers (per store database).
// -----------------------------------------------------------------------------
import type { Tx } from "../db/stores.js";
import { num } from "../lib/money.js";

export async function getSettings(tx: Tx) {
  const existing = await tx.storeSettings.findUnique({ where: { id: 1 } });
  return existing ?? tx.storeSettings.create({ data: { id: 1 } });
}

/**
 * Which store this database is. The id is PostgreSQL's system identifier,
 * which is different for every data directory — so each store's drive has
 * its own id (the sale screen uses it to keep unfinished sales apart).
 */
export async function storeIdentity(tx: Tx): Promise<{ id: string; name: string }> {
  const settings = await getSettings(tx);
  let id = "";
  try {
    const rows = await tx.$queryRaw<{ id: string }[]>`SELECT system_identifier::text AS id FROM pg_control_system()`;
    id = rows[0]?.id ?? "";
  } catch {
    /* not allowed for this database user — fall back to the store name */
  }
  return { id: id || settings.name || "store", name: settings.name || "Store" };
}

export async function getMarkupPct(tx: Tx, tierCode: string): Promise<number> {
  const tier = await tx.priceTier.findUnique({ where: { code: tierCode } });
  return tier ? num(tier.markupPct) : 0;
}

export async function getDefaultTaxRatePct(tx: Tx): Promise<number> {
  const rate = await tx.taxRate.findFirst({ where: { isDefault: true, active: true } });
  return rate ? num(rate.ratePct) : 0;
}
