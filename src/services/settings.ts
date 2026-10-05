// -----------------------------------------------------------------------------
// Store settings, tax rates and price tiers (per store database).
// -----------------------------------------------------------------------------
import type { Tx } from "../db/stores.js";
import { num } from "../lib/money.js";

export async function getSettings(tx: Tx) {
  const existing = await tx.storeSettings.findUnique({ where: { id: 1 } });
  return existing ?? tx.storeSettings.create({ data: { id: 1 } });
}

export async function getMarkupPct(tx: Tx, tierCode: string): Promise<number> {
  const tier = await tx.priceTier.findUnique({ where: { code: tierCode } });
  return tier ? num(tier.markupPct) : 0;
}

export async function getDefaultTaxRatePct(tx: Tx): Promise<number> {
  const rate = await tx.taxRate.findFirst({ where: { isDefault: true, active: true } });
  return rate ? num(rate.ratePct) : 0;
}
