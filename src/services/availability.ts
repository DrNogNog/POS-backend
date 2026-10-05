// -----------------------------------------------------------------------------
// Stock availability = what's on the shelf minus what we've already promised.
//
//   on hand    — units in stock now (invoices have already taken theirs out)
//   promised   — units on estimates that are awaiting approval or approved but
//                not yet invoiced (the Approvals board)
//   available  — on hand − promised: what a NEW estimate or sale can count on
//
// Used by the sale screen (to warn) and by saving estimates / invoices (to
// stop over-selling unless "save anyway" / "special order" is ticked).
// -----------------------------------------------------------------------------
import type { Tx } from "../db/stores.js";
import { badRequest } from "../lib/http.js";
import { num, round3 } from "../lib/money.js";

export interface Availability {
  productId: number;
  itemCode: string;
  onHand: number;
  /** On estimates that are approved but not invoiced yet. */
  approved: number;
  /** On estimates still waiting for approval. */
  pending: number;
  available: number;
}

export async function availability(
  tx: Tx,
  productIds: number[],
  opts: { excludeEstimateId?: number | null } = {}
): Promise<Map<number, Availability>> {
  const ids = [...new Set(productIds.filter(Boolean))];
  const out = new Map<number, Availability>();
  if (!ids.length) return out;
  const [products, promised] = await Promise.all([
    tx.product.findMany({ where: { id: { in: ids } }, select: { id: true, itemCode: true, qtyOnHand: true } }),
    tx.estimateLine.findMany({
      where: {
        productId: { in: ids },
        estimate: {
          status: { in: ["PENDING", "APPROVED"] },
          ...(opts.excludeEstimateId ? { id: { not: opts.excludeEstimateId } } : {}),
        },
      },
      select: { productId: true, qty: true, estimate: { select: { status: true } } },
    }),
  ]);
  for (const p of products) {
    out.set(p.id, { productId: p.id, itemCode: p.itemCode, onHand: num(p.qtyOnHand), approved: 0, pending: 0, available: 0 });
  }
  for (const l of promised) {
    const a = out.get(l.productId!);
    if (!a) continue;
    if (l.estimate.status === "APPROVED") a.approved = round3(a.approved + num(l.qty));
    else a.pending = round3(a.pending + num(l.qty));
  }
  for (const a of out.values()) a.available = round3(a.onHand - a.approved - a.pending);
  return out;
}

/**
 * Throws if the lines need more than is available (after other commitments),
 * unless `allow` is set. `what` words the error for estimates or invoices.
 */
export async function assertAvailable(
  tx: Tx,
  lines: { productId: number | null; qty: number }[],
  opts: { excludeEstimateId?: number | null; allow?: boolean; what: "estimate" | "invoice" }
) {
  if (opts.allow) return;
  const need = new Map<number, number>();
  for (const l of lines) if (l.productId) need.set(l.productId, round3((need.get(l.productId) ?? 0) + l.qty));
  const avail = await availability(tx, [...need.keys()], opts);
  const short = [...need.entries()]
    .map(([id, qty]) => ({ qty, a: avail.get(id)! }))
    .filter((x) => x.a && x.qty > x.a.available);
  if (!short.length) return;
  const detail = short
    .map(({ qty, a }) => {
      const promised = a.approved + a.pending;
      return `${a.itemCode}: ${qty} needed, ${a.onHand} on hand${promised ? `, ${promised} already promised on other estimates` : ""} → ${Math.max(0, a.available)} available`;
    })
    .join("; ");
  throw badRequest(
    `Not enough stock — ${detail}. ` +
      (opts.what === "estimate" ? `Tick "Save estimate anyway" to save it.` : `Tick "Special order — sell anyway" to invoice it.`)
  );
}
