// -----------------------------------------------------------------------------
// Purchasing & Accounts Payable service.
//
//   Purchase Order (DRAFT -> ORDERED) --receive--> stock in + Supplier Bill (A/P)
//   Supplier Bill --payments--> Paid   (early-pay discount / late fees)
//
// Freight and tax on a received order are spread over the items ("landed
// cost"), so the inventory cost reflects what the goods really cost us.
// -----------------------------------------------------------------------------
import type { PaymentMethod, Prisma } from "@prisma/client";
import type { Tx } from "../db/stores.js";
import type { AuthUser } from "../middleware/auth.js";
import { badRequest, notFound } from "../lib/http.js";
import { num, round2, round3, round4 } from "../lib/money.js";
import { logActivity } from "../lib/history.js";
import { nextPoNo } from "../lib/numbering.js";
import { netCost } from "../domain/pricing.js";
import { ACC, billEntry, supplierLateFeeEntry, supplierPaymentEntry } from "../domain/accounts.js";
import {
  applyPayment,
  balanceDue,
  daysPastDue,
  dueDateFor,
  earlyDiscountAvailable,
  lateFeeAmount,
  statusFor,
} from "../domain/terms.js";
import { getSettings } from "./settings.js";
import { receiveStock } from "./inventory.js";
import { postEntry } from "./journal.js";

export interface PoLineInput {
  productId: number;
  qty: number;
  listPrice?: number | null;
  discountPct?: number | null;
}

export async function savePurchaseOrder(
  tx: Tx,
  input: {
    id?: number;
    supplierId: number;
    expectedDate?: Date | null;
    notes?: string;
    lines: PoLineInput[];
  },
  user: AuthUser
) {
  const supplier = await tx.supplier.findUnique({ where: { id: input.supplierId } });
  if (!supplier) throw badRequest("Supplier not found");
  if (input.lines.length === 0) throw badRequest("Add at least one item");
  const products = await tx.product.findMany({
    where: { id: { in: input.lines.map((l) => l.productId) } },
  });
  const byId = new Map(products.map((p) => [p.id, p]));

  const lines = input.lines.map((l, i) => {
    const p = byId.get(l.productId);
    if (!p) throw badRequest(`Line ${i + 1}: product not found`);
    if (!(l.qty > 0)) throw badRequest(`Line ${i + 1}: quantity must be more than zero`);
    const listPrice = l.listPrice ?? num(p.listPrice);
    const discountPct =
      l.discountPct ?? (num(p.supplierDiscountPct) || num(supplier.tradeDiscountPct));
    const unitCost = listPrice > 0 ? netCost(listPrice, discountPct) : num(p.unitCost);
    return {
      productId: p.id,
      qty: round3(l.qty),
      listPrice: round2(listPrice),
      discountPct,
      unitCost,
      lineTotal: round2(l.qty * unitCost),
    };
  });
  const subtotal = round2(lines.reduce((s, l) => s + l.lineTotal, 0));

  if (input.id) {
    const existing = await tx.purchaseOrder.findUnique({ where: { id: input.id } });
    if (!existing) throw notFound("Purchase order");
    if (existing.status === "RECEIVED") throw badRequest("Already received");
    await tx.purchaseOrderLine.deleteMany({ where: { purchaseOrderId: input.id } });
    return tx.purchaseOrder.update({
      where: { id: input.id },
      data: {
        supplierId: supplier.id,
        expectedDate: input.expectedDate ?? null,
        notes: input.notes ?? "",
        subtotal,
        lines: { create: lines },
      },
    });
  }

  const settings = await getSettings(tx);
  const poNo = await nextPoNo(tx, settings.poPrefix);
  const po = await tx.purchaseOrder.create({
    data: {
      poNo,
      supplierId: supplier.id,
      expectedDate: input.expectedDate ?? null,
      notes: input.notes ?? "",
      subtotal,
      createdBy: user.name,
      lines: { create: lines },
    },
  });
  await logActivity(tx, {
    entityType: "PurchaseOrder",
    entityId: po.id,
    entityRef: poNo,
    action: "CREATED",
    summary: `Purchase order ${poNo} to ${supplier.name}`,
    amount: subtotal,
    userName: user.name,
  });
  return po;
}

export async function markPoOrdered(tx: Tx, id: number, user: AuthUser) {
  const po = await tx.purchaseOrder.findUnique({ where: { id }, include: { supplier: true } });
  if (!po) throw notFound("Purchase order");
  if (po.status !== "DRAFT") throw badRequest(`Purchase order is ${po.status.toLowerCase()}`);
  await tx.purchaseOrder.update({ where: { id }, data: { status: "ORDERED", orderDate: new Date() } });
  await logActivity(tx, {
    entityType: "PurchaseOrder",
    entityId: id,
    entityRef: po.poNo,
    action: "ORDERED",
    summary: `${po.poNo} sent to ${po.supplier.name}`,
    amount: num(po.subtotal),
    userName: user.name,
  });
}

export async function cancelPo(tx: Tx, id: number, user: AuthUser) {
  const po = await tx.purchaseOrder.findUnique({ where: { id } });
  if (!po) throw notFound("Purchase order");
  if (po.status === "RECEIVED") throw badRequest("Already received — cannot cancel");
  await tx.purchaseOrder.update({ where: { id }, data: { status: "CANCELLED" } });
  await logActivity(tx, {
    entityType: "PurchaseOrder",
    entityId: id,
    entityRef: po.poNo,
    action: "CANCELLED",
    summary: `${po.poNo} cancelled`,
    userName: user.name,
  });
}

/**
 * Goods arrived with the supplier's invoice: stock goes in, bill goes to A/P.
 */
export async function receivePurchaseOrder(
  tx: Tx,
  poId: number,
  input: {
    billNo: string;
    billDate?: Date;
    freight?: number;
    taxAmount?: number;
    termsDays?: number | null;
    /** Quantities received per PO line. Omit to receive everything still open. */
    lines?: { lineId: number; qtyReceived: number; unitCost?: number | null }[];
    notes?: string;
  },
  user: AuthUser
) {
  const po = await tx.purchaseOrder.findUnique({
    where: { id: poId },
    include: { lines: { include: { product: true } }, supplier: true },
  });
  if (!po) throw notFound("Purchase order");
  if (po.status === "RECEIVED" || po.status === "CANCELLED") {
    throw badRequest(`Purchase order is already ${po.status.toLowerCase()}`);
  }
  if (!input.billNo.trim()) throw badRequest("Enter the supplier's invoice number");

  const wanted = new Map((input.lines ?? []).map((l) => [l.lineId, l]));
  const receiving = po.lines
    .map((l) => {
      const open = round3(num(l.qty) - num(l.qtyReceived));
      const req = input.lines ? wanted.get(l.id) : undefined;
      const qty = input.lines ? round3(req?.qtyReceived ?? 0) : open;
      const unitCost = req?.unitCost ?? num(l.unitCost);
      return { line: l, qty, unitCost: round4(unitCost) };
    })
    .filter((r) => r.qty > 0);
  if (receiving.length === 0) throw badRequest("Nothing to receive");

  const goods = round2(receiving.reduce((s, r) => s + r.qty * r.unitCost, 0));
  const freight = round2(input.freight ?? 0);
  const taxAmount = round2(input.taxAmount ?? 0);
  const extra = freight + taxAmount;
  const billDate = input.billDate ?? new Date();
  const termsDays = input.termsDays ?? po.supplier.paymentTermsDays;
  const tradeDiscount = round2(
    receiving.reduce((s, r) => s + r.qty * Math.max(0, num(r.line.listPrice) - r.unitCost), 0)
  );

  // Stock in, with freight/tax spread by value (landed cost)
  for (const r of receiving) {
    const share = goods > 0 ? (r.qty * r.unitCost) / goods : 0;
    const landedUnit = round4(r.unitCost + (extra * share) / r.qty);
    await receiveStock(tx, {
      productId: r.line.productId,
      qty: r.qty,
      unitCost: landedUnit,
      source: "PURCHASE",
      sourceRef: po.poNo,
      date: billDate,
      costUpdate: "average", // new purchases average into the standard cost
    });
    await tx.purchaseOrderLine.update({
      where: { id: r.line.id },
      data: { qtyReceived: { increment: r.qty } },
    });
  }

  const allLines = await tx.purchaseOrderLine.findMany({ where: { purchaseOrderId: po.id } });
  const fullyReceived = allLines.every((l) => num(l.qtyReceived) >= num(l.qty));
  await tx.purchaseOrder.update({
    where: { id: po.id },
    data: { status: fullyReceived ? "RECEIVED" : "ORDERED" },
  });

  const total = round2(goods + freight + taxAmount);
  const bill = await tx.supplierBill.create({
    data: {
      billNo: input.billNo.trim(),
      supplierId: po.supplierId,
      purchaseOrderId: po.id,
      billDate,
      termsDays,
      dueDate: dueDateFor(billDate, termsDays),
      expenseAccountCode: ACC.INVENTORY,
      subtotal: goods,
      freight,
      taxAmount,
      total,
      tradeDiscount,
      earlyPayDiscountPct: po.supplier.earlyPayDiscountPct,
      earlyPayDiscountDays: po.supplier.earlyPayDiscountDays,
      notes: input.notes ?? "",
      createdBy: user.name,
      lines: {
        create: receiving.map((r) => ({
          productId: r.line.productId,
          itemCode: r.line.product.itemCode,
          description: r.line.product.name,
          qty: r.qty,
          listPrice: r.line.listPrice,
          discountPct: r.line.discountPct,
          unitCost: r.unitCost,
          lineTotal: round2(r.qty * r.unitCost),
        })),
      },
    },
  });

  await postEntry(tx, {
    date: billDate,
    memo: `Received ${po.poNo} from ${po.supplier.name} (bill ${bill.billNo})`,
    sourceType: "BILL",
    sourceRef: `${po.supplier.name} #${bill.billNo}`,
    userName: user.name,
    lines: billEntry({ debitAccount: ACC.INVENTORY, amount: goods, freight, tax: taxAmount }),
  });
  await logActivity(tx, {
    entityType: "Bill",
    entityId: bill.id,
    entityRef: bill.billNo,
    action: "RECEIVED",
    summary: `Received ${po.poNo} from ${po.supplier.name}; bill ${bill.billNo} due ${bill.dueDate
      .toISOString()
      .slice(0, 10)}${tradeDiscount > 0 ? ` (saved $${tradeDiscount.toFixed(2)} supplier discount)` : ""}`,
    amount: total,
    userName: user.name,
  });
  return bill;
}

/** A bill that isn't for stock (rent, utilities, delivery...). */
export async function createExpenseBill(
  tx: Tx,
  input: {
    supplierId: number;
    billNo: string;
    billDate?: Date;
    termsDays?: number | null;
    expenseAccountCode: string;
    amount: number;
    notes?: string;
  },
  user: AuthUser
) {
  const supplier = await tx.supplier.findUnique({ where: { id: input.supplierId } });
  if (!supplier) throw badRequest("Supplier not found");
  const account = await tx.account.findUnique({ where: { code: input.expenseAccountCode } });
  if (!account || (account.type !== "EXPENSE" && account.type !== "ASSET")) {
    throw badRequest("Choose an expense account");
  }
  if (!(input.amount > 0)) throw badRequest("Amount must be more than zero");
  const billDate = input.billDate ?? new Date();
  const termsDays = input.termsDays ?? supplier.paymentTermsDays;
  const amount = round2(input.amount);
  const bill = await tx.supplierBill.create({
    data: {
      billNo: input.billNo.trim(),
      supplierId: supplier.id,
      billDate,
      termsDays,
      dueDate: dueDateFor(billDate, termsDays),
      expenseAccountCode: account.code,
      subtotal: amount,
      total: amount,
      earlyPayDiscountPct: supplier.earlyPayDiscountPct,
      earlyPayDiscountDays: supplier.earlyPayDiscountDays,
      notes: input.notes ?? "",
      createdBy: user.name,
    },
  });
  await postEntry(tx, {
    date: billDate,
    memo: `${account.name} — ${supplier.name} bill ${bill.billNo}`,
    sourceType: "BILL",
    sourceRef: `${supplier.name} #${bill.billNo}`,
    userName: user.name,
    lines: billEntry({ debitAccount: account.code, amount, freight: 0, tax: 0 }),
  });
  await logActivity(tx, {
    entityType: "Bill",
    entityId: bill.id,
    entityRef: bill.billNo,
    action: "CREATED",
    summary: `Bill ${bill.billNo} from ${supplier.name} (${account.name})`,
    amount,
    userName: user.name,
  });
  return bill;
}

function openItemOf(b: {
  billDate: Date;
  dueDate: Date;
  total: unknown;
  amountPaid: unknown;
  discountsTaken: unknown;
  lateFees: unknown;
  earlyPayDiscountPct: unknown;
  earlyPayDiscountDays: number;
}) {
  return {
    issueDate: b.billDate,
    dueDate: b.dueDate,
    total: num(b.total),
    amountPaid: num(b.amountPaid),
    discountsTaken: num(b.discountsTaken),
    lateFees: num(b.lateFees),
    earlyPayDiscountPct: num(b.earlyPayDiscountPct),
    earlyPayDiscountDays: b.earlyPayDiscountDays,
  };
}

export async function recordSupplierPayment(
  tx: Tx,
  billId: number,
  p: { amount: number; method: PaymentMethod; reference?: string; notes?: string; date?: Date; takeDiscount?: boolean },
  user: AuthUser
) {
  const bill = await tx.supplierBill.findUnique({ where: { id: billId }, include: { supplier: true } });
  if (!bill) throw notFound("Bill");
  if (bill.status === "VOID") throw badRequest("This bill is void");
  if (!(p.amount > 0)) throw badRequest("Payment amount must be more than zero");
  const item = openItemOf(bill);
  const date = p.date ?? new Date();
  const res = applyPayment(item, p.amount, date, p.takeDiscount ?? true);
  if (res.overpayment > 0.004) {
    throw badRequest(`Payment is more than the balance due ($${balanceDue(item).toFixed(2)}).`);
  }
  await tx.supplierPayment.create({
    data: {
      billId,
      supplierId: bill.supplierId,
      date,
      amount: res.cashApplied,
      discountTaken: res.discountTaken,
      method: p.method,
      reference: p.reference ?? "",
      notes: p.notes ?? "",
      createdBy: user.name,
    },
  });
  const after = {
    ...item,
    amountPaid: round2(item.amountPaid + res.cashApplied),
    discountsTaken: round2(item.discountsTaken + res.discountTaken),
  };
  await tx.supplierBill.update({
    where: { id: billId },
    data: { amountPaid: after.amountPaid, discountsTaken: after.discountsTaken, status: statusFor(after) },
  });
  await postEntry(tx, {
    date,
    memo: `Paid ${bill.supplier.name} bill ${bill.billNo}`,
    sourceType: "SUPPLIER_PAYMENT",
    sourceRef: `${bill.supplier.name} #${bill.billNo}`,
    userName: user.name,
    lines: supplierPaymentEntry({ cash: res.cashApplied, discount: res.discountTaken, method: p.method }),
  });
  await logActivity(tx, {
    entityType: "Bill",
    entityId: bill.id,
    entityRef: bill.billNo,
    action: "PAYMENT",
    summary: `Paid $${res.cashApplied.toFixed(2)} to ${bill.supplier.name} on bill ${bill.billNo}${
      res.discountTaken > 0 ? ` (took $${res.discountTaken.toFixed(2)} early-payment discount)` : ""
    }. Balance now $${res.newBalance.toFixed(2)}`,
    amount: res.cashApplied,
    userName: user.name,
  });
  return res;
}

export async function addBillLateFee(
  tx: Tx,
  billId: number,
  input: { amount?: number | null; note?: string },
  user: AuthUser
) {
  const bill = await tx.supplierBill.findUnique({ where: { id: billId }, include: { supplier: true } });
  if (!bill) throw notFound("Bill");
  if (bill.status === "PAID" || bill.status === "VOID") throw badRequest("Bill has no open balance");
  const item = openItemOf(bill);
  const amount =
    input.amount && input.amount > 0
      ? round2(input.amount)
      : lateFeeAmount(balanceDue(item), num(bill.supplier.lateFeePct), num(bill.supplier.lateFeeFlat));
  if (amount <= 0) throw badRequest("This supplier has no late fee set — enter an amount");
  await tx.billAdjustment.create({
    data: { billId, type: "LATE_FEE", amount, note: input.note ?? "", createdBy: user.name },
  });
  await tx.supplierBill.update({
    where: { id: billId },
    data: { lateFees: { increment: amount }, status: statusFor({ ...item, lateFees: item.lateFees + amount }) },
  });
  await postEntry(tx, {
    memo: `Late fee from ${bill.supplier.name} on bill ${bill.billNo}`,
    sourceType: "SUPPLIER_LATE_FEE",
    sourceRef: `${bill.supplier.name} #${bill.billNo}`,
    userName: user.name,
    lines: supplierLateFeeEntry(amount),
  });
  await logActivity(tx, {
    entityType: "Bill",
    entityId: bill.id,
    entityRef: bill.billNo,
    action: "LATE_FEE",
    summary: `${bill.supplier.name} charged a $${amount.toFixed(2)} late fee on bill ${bill.billNo}`,
    amount,
    userName: user.name,
  });
  return { amount };
}

export function presentBill<T extends Prisma.SupplierBillGetPayload<object>>(b: T, today = new Date()) {
  const item = openItemOf(b);
  const balance = b.status === "VOID" ? 0 : balanceDue(item);
  const discountAvailable = balance > 0 && earlyDiscountAvailable(item, today);
  return {
    ...b,
    balance,
    daysPastDue: balance > 0 ? daysPastDue(b.dueDate, today) : 0,
    isOverdue: balance > 0 && daysPastDue(b.dueDate, today) > 0,
    earlyDiscountAvailableNow: discountAvailable,
    earlyDiscountAmount: round2((item.total * item.earlyPayDiscountPct) / 100),
    earlyDiscountDeadline:
      item.earlyPayDiscountDays > 0 && item.earlyPayDiscountPct > 0
        ? new Date(b.billDate.getTime() + item.earlyPayDiscountDays * 86400000)
        : null,
  };
}
