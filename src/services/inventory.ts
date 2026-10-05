// -----------------------------------------------------------------------------
// Inventory service: the ONLY place stock levels change.
//
//   receiveStock  -> adds a cost layer (lot) + RECEIVE / ADJUST_IN movement
//   issueStock    -> takes units out using the store's costing method
//   adjustStock   -> manual count corrections (with journal entry)
// -----------------------------------------------------------------------------
import type { CostingMethod, MovementType } from "@prisma/client";
import type { Tx } from "../db/stores.js";
import { consumeLots } from "../domain/costing.js";
import { inventoryAdjustmentEntry } from "../domain/accounts.js";
import { badRequest } from "../lib/http.js";
import { num, round2, round3, round4 } from "../lib/money.js";
import { postEntry } from "./journal.js";
import { logActivity } from "../lib/history.js";

export async function receiveStock(
  tx: Tx,
  i: {
    productId: number;
    qty: number;
    unitCost: number;
    source: "PURCHASE" | "OPENING" | "ADJUSTMENT" | "RETURN";
    sourceRef?: string;
    date?: Date;
    note?: string;
    updateStandardCost?: boolean;
  }
) {
  if (i.qty <= 0) throw badRequest("Quantity received must be more than zero");
  const qty = round3(i.qty);
  const unitCost = round4(i.unitCost);
  const movementType: MovementType =
    i.source === "PURCHASE" ? "RECEIVE" : i.source === "RETURN" ? "RETURN_IN" : "ADJUST_IN";

  await tx.inventoryLot.create({
    data: {
      productId: i.productId,
      receivedAt: i.date ?? new Date(),
      qtyReceived: qty,
      qtyRemaining: qty,
      unitCost,
      source: i.source,
      sourceRef: i.sourceRef ?? "",
    },
  });
  await tx.inventoryMovement.create({
    data: {
      productId: i.productId,
      type: movementType,
      qty,
      unitCost,
      totalCost: round2(qty * unitCost),
      reference: i.sourceRef ?? "",
      note: i.note ?? "",
      createdAt: i.date ?? new Date(),
    },
  });
  await tx.product.update({
    where: { id: i.productId },
    data: {
      qtyOnHand: { increment: qty },
      ...(i.updateStandardCost ? { unitCost } : {}),
    },
  });
  return { qty, unitCost, totalCost: round2(qty * unitCost) };
}

/**
 * Take `qty` units out of stock. Returns the cost (for COGS).
 * If `allowShort` is false and there isn't enough stock, throws.
 */
export async function issueStock(
  tx: Tx,
  i: {
    productId: number;
    qty: number;
    method: CostingMethod;
    type: Extract<MovementType, "SALE" | "ADJUST_OUT">;
    reference: string;
    allowShort?: boolean;
    note?: string;
  }
) {
  const product = await tx.product.findUnique({ where: { id: i.productId } });
  if (!product) throw badRequest(`Product #${i.productId} not found`);
  const qty = round3(i.qty);
  const lots = await tx.inventoryLot.findMany({
    where: { productId: i.productId, qtyRemaining: { gt: 0 } },
  });
  const result = consumeLots(
    lots.map((l) => ({
      id: l.id,
      receivedAt: l.receivedAt,
      qtyRemaining: num(l.qtyRemaining),
      unitCost: num(l.unitCost),
    })),
    qty,
    i.method,
    num(product.unitCost)
  );
  if (result.shortQty > 0 && !i.allowShort) {
    const onHand = round3(qty - result.shortQty);
    throw badRequest(
      `Not enough stock for ${product.itemCode}: ${onHand} on hand, ${qty} needed. ` +
        `Tick "special order / allow backorder" to sell it anyway.`
    );
  }
  for (const d of result.draws) {
    await tx.inventoryLot.update({
      where: { id: Number(d.lotId) },
      data: { qtyRemaining: { decrement: d.qty } },
    });
  }
  await tx.inventoryMovement.create({
    data: {
      productId: i.productId,
      type: i.type,
      qty,
      unitCost: result.unitCost,
      totalCost: result.totalCost,
      reference: i.reference,
      note: i.note ?? (result.shortQty > 0 ? `${result.shortQty} on backorder` : ""),
    },
  });
  await tx.product.update({
    where: { id: i.productId },
    data: { qtyOnHand: { decrement: qty } },
  });
  return result;
}

/** Manual stock correction: positive adds stock, negative removes it. */
export async function adjustStock(
  tx: Tx,
  i: {
    productId: number;
    qtyChange: number;
    unitCost?: number;
    reason: string;
    method: CostingMethod;
    userName: string;
  }
) {
  const product = await tx.product.findUnique({ where: { id: i.productId } });
  if (!product) throw badRequest("Product not found");
  const ref = `ADJ-${product.itemCode}`;
  let value: number;
  if (i.qtyChange > 0) {
    const unitCost = i.unitCost ?? num(product.unitCost);
    const res = await receiveStock(tx, {
      productId: product.id,
      qty: i.qtyChange,
      unitCost,
      source: "ADJUSTMENT",
      sourceRef: ref,
      note: i.reason,
    });
    value = res.totalCost;
  } else if (i.qtyChange < 0) {
    const res = await issueStock(tx, {
      productId: product.id,
      qty: -i.qtyChange,
      method: i.method,
      type: "ADJUST_OUT",
      reference: ref,
      note: i.reason,
    });
    value = -res.totalCost;
  } else {
    throw badRequest("Quantity change cannot be zero");
  }
  await postEntry(tx, {
    memo: `Stock adjustment ${product.itemCode}: ${i.reason}`,
    sourceType: "INVENTORY_ADJUSTMENT",
    sourceRef: product.itemCode,
    userName: i.userName,
    lines: inventoryAdjustmentEntry(value),
  });
  await logActivity(tx, {
    entityType: "Product",
    entityId: product.id,
    entityRef: product.itemCode,
    action: "STOCK_ADJUSTED",
    summary: `${i.qtyChange > 0 ? "Added" : "Removed"} ${Math.abs(i.qtyChange)} ${product.unit} of ${product.itemCode} (${i.reason})`,
    amount: value,
    userName: i.userName,
  });
  return { value };
}
