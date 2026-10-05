// -----------------------------------------------------------------------------
// Pricing.
//   Price in  = list price - supplier discount        (what we pay)
//   Price out = price in x (1 + tier markup)           (what the customer pays)
// Tiers AA, A, B, C, D are set per store on the Settings screen.
// A product can also have a fixed selling price that overrides the tiers.
// -----------------------------------------------------------------------------
import { round2, round4 } from "../lib/money.js";

/** Net cost after the supplier's discount off list. */
export function netCost(listPrice: number, discountPct: number): number {
  return round4(listPrice * (1 - discountPct / 100));
}

export function tierPrice(unitCost: number, markupPct: number): number {
  return round2(unitCost * (1 + markupPct / 100));
}

export function sellingPrice(
  product: { unitCost: number; sellPriceOverride: number | null },
  markupPct: number
): number {
  if (product.sellPriceOverride !== null && product.sellPriceOverride > 0) {
    return round2(product.sellPriceOverride);
  }
  return tierPrice(product.unitCost, markupPct);
}

/** Gross margin % = (price - cost) / price. */
export function marginPct(price: number, cost: number): number {
  if (price <= 0) return 0;
  return round2(((price - cost) / price) * 100);
}
