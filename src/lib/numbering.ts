// -----------------------------------------------------------------------------
// Document numbers: EST-1001, INV-1001, PO-1001 ...
// Finds the highest existing number with the prefix and adds one.
// -----------------------------------------------------------------------------
import type { Tx } from "../db/stores.js";

export function nextNumber(existing: string[], prefix: string, start = 1001): string {
  let max = start - 1;
  for (const value of existing) {
    if (!value.startsWith(prefix)) continue;
    const n = Number(value.slice(prefix.length));
    if (Number.isInteger(n) && n > max) max = n;
  }
  return `${prefix}${max + 1}`;
}

export async function nextInvoiceNo(tx: Tx, prefix: string) {
  const rows = await tx.invoice.findMany({
    where: { invoiceNo: { startsWith: prefix } },
    select: { invoiceNo: true },
  });
  return nextNumber(rows.map((r) => r.invoiceNo), prefix);
}

export async function nextEstimateNo(tx: Tx, prefix: string) {
  const rows = await tx.estimate.findMany({
    where: { estimateNo: { startsWith: prefix } },
    select: { estimateNo: true },
  });
  return nextNumber(rows.map((r) => r.estimateNo), prefix);
}

export async function nextPoNo(tx: Tx, prefix: string) {
  const rows = await tx.purchaseOrder.findMany({
    where: { poNo: { startsWith: prefix } },
    select: { poNo: true },
  });
  return nextNumber(rows.map((r) => r.poNo), prefix);
}
