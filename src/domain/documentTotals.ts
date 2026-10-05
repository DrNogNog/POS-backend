// -----------------------------------------------------------------------------
// Totals for estimates and invoices.
//
//   subtotal  = Σ qty x unit price
//   discount  = dollars off the whole order (spread over lines for tax)
//   tax       = tax rate x (taxable lines - their share of the discount)
//   total     = subtotal - discount + tax
// -----------------------------------------------------------------------------
import { percentOf, round2 } from "../lib/money.js";

export interface PricedLine {
  qty: number;
  unitPrice: number;
  taxable: boolean;
}

export interface DocumentTotals {
  lineTotals: number[];
  subtotal: number;
  discountAmount: number;
  taxableBase: number;
  taxAmount: number;
  total: number;
}

export function documentTotals(
  lines: PricedLine[],
  discountAmount: number,
  taxRatePct: number
): DocumentTotals {
  const lineTotals = lines.map((l) => round2(l.qty * l.unitPrice));
  const subtotal = round2(lineTotals.reduce((a, b) => a + b, 0));
  const discount = round2(Math.min(Math.max(0, discountAmount), subtotal));
  const taxableSubtotal = round2(
    lines.reduce((s, l, i) => (l.taxable ? s + lineTotals[i] : s), 0)
  );
  const taxableShareOfDiscount = subtotal > 0 ? (discount * taxableSubtotal) / subtotal : 0;
  const taxableBase = round2(taxableSubtotal - taxableShareOfDiscount);
  const taxAmount = percentOf(taxableBase, taxRatePct);
  return {
    lineTotals,
    subtotal,
    discountAmount: discount,
    taxableBase,
    taxAmount,
    total: round2(subtotal - discount + taxAmount),
  };
}

/** Convert a discount entered as a percent into dollars. */
export function discountFromPercent(subtotal: number, pct: number): number {
  return percentOf(subtotal, pct);
}
