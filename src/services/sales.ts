// -----------------------------------------------------------------------------
// Sales & Accounts Receivable service.
//
//   Estimate  --approve-->  Invoice  --payments-->  Paid
//                              |-- late fee / collections / write-off
//
// Every action: updates the documents, moves stock, posts the journal entry
// and writes a History line — all in ONE database transaction, so nothing can
// be half-done (e.g. stock taken out but no invoice saved).
// -----------------------------------------------------------------------------
import type { Fulfillment, PaymentMethod, Prisma } from "@prisma/client";
import type { Tx } from "../db/stores.js";
import type { AuthUser } from "../middleware/auth.js";
import { badRequest, notFound } from "../lib/http.js";
import { num, round2 } from "../lib/money.js";
import { logActivity } from "../lib/history.js";
import { nextEstimateNo, nextInvoiceNo } from "../lib/numbering.js";
import { documentTotals } from "../domain/documentTotals.js";
import {
  customerLateFeeEntry,
  customerPaymentEntry,
  reverse,
  saleEntry,
  writeOffEntry,
} from "../domain/accounts.js";
import {
  applyPayment,
  balanceDue,
  daysPastDue,
  dueDateFor,
  earlyDiscountAvailable,
  lateFeeAmount,
  statusFor,
} from "../domain/terms.js";
import { getDefaultTaxRatePct, getSettings } from "./settings.js";
import { assertAvailable } from "./availability.js";
import { issueStock, receiveStock } from "./inventory.js";
import { postEntry } from "./journal.js";

export interface LineInput {
  productId?: number | null;
  itemCode?: string;
  description?: string;
  qty: number;
  unitPrice: number;
}

export interface DocumentInput {
  customerId?: number | null;
  billTo?: string;
  shipTo?: string;
  phone?: string;
  fax?: string;
  fulfillment?: Fulfillment;
  priceTierCode?: string;
  discountAmount?: number;
  /** Leave empty to use the store default (or 0 for tax-exempt customers). */
  taxRatePct?: number | null;
  notes?: string;
  lines: LineInput[];
  /** Save an estimate even though there isn't enough stock available for it. */
  allowShortage?: boolean;
}

/** Look up products for the lines and fill in item code / description / taxable. */
async function resolveLines(tx: Tx, lines: LineInput[]) {
  if (lines.length === 0) throw badRequest("Add at least one line item");
  const ids = lines.map((l) => l.productId).filter((id): id is number => !!id);
  const products = await tx.product.findMany({ where: { id: { in: ids } } });
  const byId = new Map(products.map((p) => [p.id, p]));
  return lines.map((l, index) => {
    if (!(l.qty > 0)) throw badRequest(`Line ${index + 1}: quantity must be more than zero`);
    if (l.unitPrice < 0) throw badRequest(`Line ${index + 1}: price cannot be negative`);
    const product = l.productId ? byId.get(l.productId) : undefined;
    if (l.productId && !product) throw badRequest(`Line ${index + 1}: product not found`);
    return {
      productId: product?.id ?? null,
      itemCode: product?.itemCode ?? (l.itemCode || "").trim(),
      description: (l.description || product?.name || "").trim(),
      qty: l.qty,
      unitPrice: round2(l.unitPrice),
      taxable: product ? product.taxable : true,
      sortOrder: index,
    };
  });
}

async function resolveTaxRate(tx: Tx, customerId: number | null | undefined, requested?: number | null) {
  if (customerId) {
    const c = await tx.customer.findUnique({ where: { id: customerId } });
    if (!c) throw badRequest("Customer not found");
    if (c.taxExempt) return 0;
  }
  if (requested !== undefined && requested !== null) return requested;
  return getDefaultTaxRatePct(tx);
}

// ============================================================================
// ESTIMATES
// ============================================================================

export async function saveEstimate(
  tx: Tx,
  input: DocumentInput & { id?: number },
  user: AuthUser
) {
  const settings = await getSettings(tx);
  const lines = await resolveLines(tx, input.lines);
  // Count what's already promised on other estimates (not this one)
  await assertAvailable(tx, lines, { excludeEstimateId: input.id, allow: input.allowShortage, what: "estimate" });
  const taxRatePct = await resolveTaxRate(tx, input.customerId, input.taxRatePct);
  const totals = documentTotals(lines, input.discountAmount ?? 0, taxRatePct);

  const customer = input.customerId ? await tx.customer.findUnique({ where: { id: input.customerId } }) : null;
  const data = {
    customerId: input.customerId ?? null,
    billTo: input.billTo ?? "",
    shipTo: input.shipTo ?? "",
    phone: input.phone || customer?.phone || "",
    fax: input.fax || customer?.fax || "",
    fulfillment: input.fulfillment ?? "PICKUP",
    priceTierCode: input.priceTierCode ?? "AA",
    subtotal: totals.subtotal,
    discountAmount: totals.discountAmount,
    taxRatePct,
    taxAmount: totals.taxAmount,
    total: totals.total,
    notes: input.notes ?? "",
  };
  const lineData = lines.map((l, i) => ({
    productId: l.productId,
    itemCode: l.itemCode,
    description: l.description,
    qty: l.qty,
    unitPrice: l.unitPrice,
    lineTotal: totals.lineTotals[i],
    sortOrder: l.sortOrder,
  }));

  if (input.id) {
    const existing = await tx.estimate.findUnique({ where: { id: input.id } });
    if (!existing) throw notFound("Estimate");
    if (existing.status === "INVOICED") throw badRequest("This estimate is already invoiced");
    await tx.estimateLine.deleteMany({ where: { estimateId: input.id } });
    const est = await tx.estimate.update({
      where: { id: input.id },
      data: { ...data, status: "PENDING", approvedAt: null, lines: { create: lineData } },
    });
    await logActivity(tx, {
      entityType: "Estimate",
      entityId: est.id,
      entityRef: est.estimateNo,
      action: "UPDATED",
      summary: `Estimate ${est.estimateNo} updated (${data.billTo.split("\n")[0] || "no customer"})`,
      amount: totals.total,
      userName: user.name,
    });
    return est;
  }

  const estimateNo = await nextEstimateNo(tx, settings.estimatePrefix);
  const est = await tx.estimate.create({
    data: { ...data, estimateNo, createdBy: user.name, lines: { create: lineData } },
  });
  await logActivity(tx, {
    entityType: "Estimate",
    entityId: est.id,
    entityRef: est.estimateNo,
    action: "CREATED",
    summary: `Estimate ${est.estimateNo} created for ${data.billTo.split("\n")[0] || "walk-in"}`,
    amount: totals.total,
    userName: user.name,
  });
  return est;
}

export async function setEstimateStatus(
  tx: Tx,
  id: number,
  status: "APPROVED" | "REJECTED" | "PENDING",
  user: AuthUser
) {
  const est = await tx.estimate.findUnique({ where: { id } });
  if (!est) throw notFound("Estimate");
  if (est.status === "INVOICED") throw badRequest("Already invoiced");
  const updated = await tx.estimate.update({
    where: { id },
    data: { status, approvedAt: status === "APPROVED" ? new Date() : null },
  });
  await logActivity(tx, {
    entityType: "Estimate",
    entityId: id,
    entityRef: est.estimateNo,
    action: status,
    summary: `Estimate ${est.estimateNo} ${status.toLowerCase()}`,
    amount: num(est.total),
    userName: user.name,
  });
  return updated;
}

// ============================================================================
// INVOICES
// ============================================================================

export interface InvoiceInput extends DocumentInput {
  estimateId?: number | null;
  termsDays?: number | null;
  issueDate?: Date;
  salesperson?: string;
  allowBackorder?: boolean;
  /** Take payment right away (cash register sale). */
  payment?: { amount: number; method: PaymentMethod; reference?: string } | null;
}

export async function createInvoice(tx: Tx, input: InvoiceInput, user: AuthUser) {
  const settings = await getSettings(tx);
  const lines = await resolveLines(tx, input.lines);
  // Stock promised on estimates counts as taken — except this sale's own estimate
  await assertAvailable(tx, lines, { excludeEstimateId: input.estimateId, allow: input.allowBackorder, what: "invoice" });
  const taxRatePct = await resolveTaxRate(tx, input.customerId, input.taxRatePct);
  const totals = documentTotals(lines, input.discountAmount ?? 0, taxRatePct);

  const customer = input.customerId
    ? await tx.customer.findUnique({ where: { id: input.customerId } })
    : null;
  const termsDays = Math.max(0, input.termsDays ?? customer?.termsDays ?? 0);
  const issueDate = input.issueDate ?? new Date();
  const invoiceNo = await nextInvoiceNo(tx, settings.invoicePrefix);

  // Early-payment discount is only offered on invoices with terms.
  const earlyPct = termsDays > 0 ? num(settings.earlyPayDiscountPct) : 0;
  const earlyDays = termsDays > 0 ? Math.min(settings.earlyPayDiscountDays, termsDays) : 0;

  // 1) Take stock out and work out cost of goods sold
  let cogsTotal = 0;
  const costed: { unitCost: number; costTotal: number }[] = [];
  for (const l of lines) {
    if (!l.productId) {
      costed.push({ unitCost: 0, costTotal: 0 });
      continue;
    }
    const res = await issueStock(tx, {
      productId: l.productId,
      qty: l.qty,
      method: settings.costingMethod,
      type: "SALE",
      reference: invoiceNo,
      allowShort: input.allowBackorder,
    });
    costed.push({ unitCost: res.unitCost, costTotal: res.totalCost });
    cogsTotal = round2(cogsTotal + res.totalCost);
  }

  // 2) Save the invoice
  const invoice = await tx.invoice.create({
    data: {
      invoiceNo,
      customerId: customer?.id ?? null,
      estimateId: input.estimateId ?? null,
      issueDate,
      termsDays,
      dueDate: dueDateFor(issueDate, termsDays),
      billTo: input.billTo ?? customer?.billingAddress ?? "",
      shipTo: input.shipTo ?? customer?.shippingAddress ?? "",
      phone: input.phone || customer?.phone || "",
      fax: input.fax || customer?.fax || "",
      fulfillment: input.fulfillment ?? customer?.fulfillment ?? "PICKUP",
      salesperson: input.salesperson || user.name,
      priceTierCode: input.priceTierCode ?? "",
      subtotal: totals.subtotal,
      discountAmount: totals.discountAmount,
      taxRatePct,
      taxAmount: totals.taxAmount,
      total: totals.total,
      cogsTotal,
      earlyPayDiscountPct: earlyPct,
      earlyPayDiscountDays: earlyDays,
      notes: input.notes ?? "",
      createdBy: user.name,
      lines: {
        create: lines.map((l, i) => ({
          productId: l.productId,
          itemCode: l.itemCode,
          description: l.description,
          qty: l.qty,
          unitPrice: l.unitPrice,
          lineTotal: totals.lineTotals[i],
          unitCost: costed[i].unitCost,
          costTotal: costed[i].costTotal,
          sortOrder: l.sortOrder,
        })),
      },
    },
  });

  // 3) Books: A/R up, Sales + Tax up, COGS up, Inventory down
  await postEntry(tx, {
    date: issueDate,
    memo: `Sale ${invoiceNo}${customer ? " — " + customer.name : ""}`,
    sourceType: "INVOICE",
    sourceRef: invoiceNo,
    userName: user.name,
    lines: saleEntry({
      total: totals.total,
      netSales: round2(totals.subtotal - totals.discountAmount),
      tax: totals.taxAmount,
      cogs: cogsTotal,
    }),
  });

  if (input.estimateId) {
    await tx.estimate.update({ where: { id: input.estimateId }, data: { status: "INVOICED" } });
  }

  await logActivity(tx, {
    entityType: "Invoice",
    entityId: invoice.id,
    entityRef: invoiceNo,
    action: "CREATED",
    summary: `Invoice ${invoiceNo} for ${customer?.name || (input.billTo || "walk-in").split("\n")[0]} — ${
      termsDays > 0 ? `net ${termsDays}` : "due on receipt"
    }`,
    amount: totals.total,
    userName: user.name,
    details: { cogs: cogsTotal, tax: totals.taxAmount, discount: totals.discountAmount },
  });

  // 4) Optional immediate payment (register sale)
  if (input.payment && input.payment.amount > 0) {
    await recordCustomerPayment(
      tx,
      invoice.id,
      { ...input.payment, date: issueDate, takeDiscount: false },
      user
    );
  }
  return tx.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
}

export async function invoiceFromEstimate(
  tx: Tx,
  estimateId: number,
  options: { termsDays?: number | null; allowBackorder?: boolean },
  user: AuthUser
) {
  const est = await tx.estimate.findUnique({
    where: { id: estimateId },
    include: { lines: { orderBy: { sortOrder: "asc" } } },
  });
  if (!est) throw notFound("Estimate");
  if (est.status === "INVOICED") throw badRequest("This estimate was already invoiced");
  if (est.status !== "APPROVED") throw badRequest("Approve the estimate before invoicing it");
  return createInvoice(
    tx,
    {
      estimateId: est.id,
      customerId: est.customerId,
      billTo: est.billTo,
      shipTo: est.shipTo,
      phone: est.phone,
      fax: est.fax,
      fulfillment: est.fulfillment,
      priceTierCode: est.priceTierCode,
      discountAmount: num(est.discountAmount),
      taxRatePct: num(est.taxRatePct),
      notes: est.notes,
      termsDays: options.termsDays,
      allowBackorder: options.allowBackorder,
      lines: est.lines.map((l) => ({
        productId: l.productId,
        itemCode: l.itemCode,
        description: l.description,
        qty: num(l.qty),
        unitPrice: num(l.unitPrice),
      })),
    },
    user
  );
}

function openItemOf(inv: {
  issueDate: Date;
  dueDate: Date;
  total: unknown;
  amountPaid: unknown;
  discountsTaken: unknown;
  lateFees: unknown;
  writtenOff: unknown;
  earlyPayDiscountPct: unknown;
  earlyPayDiscountDays: number;
}) {
  return {
    issueDate: inv.issueDate,
    dueDate: inv.dueDate,
    total: num(inv.total),
    amountPaid: num(inv.amountPaid),
    discountsTaken: num(inv.discountsTaken),
    lateFees: num(inv.lateFees),
    writtenOff: num(inv.writtenOff),
    earlyPayDiscountPct: num(inv.earlyPayDiscountPct),
    earlyPayDiscountDays: inv.earlyPayDiscountDays,
  };
}

export async function recordCustomerPayment(
  tx: Tx,
  invoiceId: number,
  p: {
    amount: number;
    method: PaymentMethod;
    reference?: string;
    notes?: string;
    date?: Date;
    takeDiscount?: boolean;
  },
  user: AuthUser
) {
  const inv = await tx.invoice.findUnique({ where: { id: invoiceId } });
  if (!inv) throw notFound("Invoice");
  if (inv.status === "VOID") throw badRequest("This invoice is void");
  if (!(p.amount > 0)) throw badRequest("Payment amount must be more than zero");
  const item = openItemOf(inv);
  const date = p.date ?? new Date();
  const res = applyPayment(item, p.amount, date, p.takeDiscount ?? true);
  if (res.overpayment > 0.004) {
    throw badRequest(
      `Payment is $${res.overpayment.toFixed(2)} more than the balance due ($${balanceDue(item).toFixed(2)}).`
    );
  }

  const payment = await tx.customerPayment.create({
    data: {
      invoiceId,
      customerId: inv.customerId,
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
  await tx.invoice.update({
    where: { id: invoiceId },
    data: {
      amountPaid: after.amountPaid,
      discountsTaken: after.discountsTaken,
      status: statusFor(after),
    },
  });
  await postEntry(tx, {
    date,
    memo: `Payment on ${inv.invoiceNo} (${p.method.toLowerCase()})`,
    sourceType: "CUSTOMER_PAYMENT",
    sourceRef: inv.invoiceNo,
    userName: user.name,
    lines: customerPaymentEntry({ cash: res.cashApplied, discount: res.discountTaken, method: p.method }),
  });
  await logActivity(tx, {
    entityType: "Invoice",
    entityId: inv.id,
    entityRef: inv.invoiceNo,
    action: "PAYMENT",
    summary: `Received $${res.cashApplied.toFixed(2)} ${p.method.toLowerCase()} on ${inv.invoiceNo}${
      res.discountTaken > 0 ? ` + $${res.discountTaken.toFixed(2)} early-payment discount` : ""
    }. Balance now $${res.newBalance.toFixed(2)}`,
    amount: res.cashApplied,
    userName: user.name,
  });
  return { payment, ...res };
}

export async function addInvoiceLateFee(
  tx: Tx,
  invoiceId: number,
  input: { amount?: number | null; note?: string },
  user: AuthUser
) {
  const inv = await tx.invoice.findUnique({ where: { id: invoiceId } });
  if (!inv) throw notFound("Invoice");
  if (inv.status === "PAID" || inv.status === "VOID") throw badRequest("Invoice has no open balance");
  const settings = await getSettings(tx);
  const item = openItemOf(inv);
  const amount =
    input.amount && input.amount > 0
      ? round2(input.amount)
      : lateFeeAmount(balanceDue(item), num(settings.lateFeePct), num(settings.lateFeeFlat));
  if (amount <= 0) throw badRequest("Late fee works out to $0 — enter an amount");

  await tx.invoiceAdjustment.create({
    data: { invoiceId, type: "LATE_FEE", amount, note: input.note ?? "", createdBy: user.name },
  });
  await tx.invoice.update({
    where: { id: invoiceId },
    data: {
      lateFees: { increment: amount },
      collectionStatus: inv.collectionStatus === "NONE" ? "LATE_FEE" : inv.collectionStatus,
      status: statusFor({ ...item, lateFees: item.lateFees + amount }),
    },
  });
  await postEntry(tx, {
    memo: `Late fee on ${inv.invoiceNo}`,
    sourceType: "LATE_FEE",
    sourceRef: inv.invoiceNo,
    userName: user.name,
    lines: customerLateFeeEntry(amount),
  });
  await logActivity(tx, {
    entityType: "Invoice",
    entityId: inv.id,
    entityRef: inv.invoiceNo,
    action: "LATE_FEE",
    summary: `Late fee $${amount.toFixed(2)} added to ${inv.invoiceNo}`,
    amount,
    userName: user.name,
  });
  return { amount };
}

export async function sendToCollections(tx: Tx, invoiceId: number, note: string, user: AuthUser) {
  const inv = await tx.invoice.findUnique({ where: { id: invoiceId } });
  if (!inv) throw notFound("Invoice");
  if (inv.status === "PAID" || inv.status === "VOID") throw badRequest("Invoice has no open balance");
  await tx.invoice.update({ where: { id: invoiceId }, data: { collectionStatus: "COLLECTIONS" } });
  await logActivity(tx, {
    entityType: "Invoice",
    entityId: inv.id,
    entityRef: inv.invoiceNo,
    action: "COLLECTIONS",
    summary: `${inv.invoiceNo} sent to collections agency${note ? ": " + note : ""}`,
    amount: balanceDue(openItemOf(inv)),
    userName: user.name,
  });
}

export async function writeOffInvoice(tx: Tx, invoiceId: number, note: string, user: AuthUser) {
  const inv = await tx.invoice.findUnique({ where: { id: invoiceId } });
  if (!inv) throw notFound("Invoice");
  const item = openItemOf(inv);
  const amount = balanceDue(item);
  if (amount <= 0) throw badRequest("Nothing left to write off");
  await tx.invoiceAdjustment.create({
    data: { invoiceId, type: "WRITE_OFF", amount, note, createdBy: user.name },
  });
  await tx.invoice.update({
    where: { id: invoiceId },
    data: {
      writtenOff: { increment: amount },
      collectionStatus: "WRITTEN_OFF",
      status: statusFor({ ...item, writtenOff: item.writtenOff + amount }),
    },
  });
  await postEntry(tx, {
    memo: `Bad debt write-off ${inv.invoiceNo}`,
    sourceType: "WRITE_OFF",
    sourceRef: inv.invoiceNo,
    userName: user.name,
    lines: writeOffEntry(amount),
  });
  await logActivity(tx, {
    entityType: "Invoice",
    entityId: inv.id,
    entityRef: inv.invoiceNo,
    action: "WRITE_OFF",
    summary: `Wrote off $${amount.toFixed(2)} on ${inv.invoiceNo} as bad debt${note ? ": " + note : ""}`,
    amount,
    userName: user.name,
  });
}

/** Cancel an invoice that has no payments: puts stock back and reverses the books. */
export async function voidInvoice(tx: Tx, invoiceId: number, reason: string, user: AuthUser) {
  const inv = await tx.invoice.findUnique({
    where: { id: invoiceId },
    include: { lines: true, payments: true, adjustments: true },
  });
  if (!inv) throw notFound("Invoice");
  if (inv.status === "VOID") throw badRequest("Already void");
  if (inv.payments.length > 0 || inv.adjustments.length > 0) {
    throw badRequest("This invoice has payments or fees. Refund/clear them before voiding.");
  }
  for (const l of inv.lines) {
    if (!l.productId) continue;
    await receiveStock(tx, {
      productId: l.productId,
      qty: num(l.qty),
      unitCost: num(l.unitCost),
      source: "RETURN",
      sourceRef: inv.invoiceNo,
      note: `Void ${inv.invoiceNo}`,
      costUpdate: "keep", // the units come back at what they cost; standard cost stays
    });
  }
  const original = await tx.journalEntry.findMany({
    where: { sourceType: "INVOICE", sourceRef: inv.invoiceNo },
    include: { lines: true },
  });
  for (const e of original) {
    await postEntry(tx, {
      memo: `VOID ${inv.invoiceNo}: ${reason}`,
      sourceType: "INVOICE_VOID",
      sourceRef: inv.invoiceNo,
      userName: user.name,
      lines: reverse(
        e.lines.map((l) => ({ account: l.accountCode, debit: num(l.debit), credit: num(l.credit) }))
      ),
    });
  }
  await tx.invoice.update({ where: { id: invoiceId }, data: { status: "VOID" } });
  if (inv.estimateId) {
    await tx.estimate.update({ where: { id: inv.estimateId }, data: { status: "APPROVED" } });
  }
  await logActivity(tx, {
    entityType: "Invoice",
    entityId: inv.id,
    entityRef: inv.invoiceNo,
    action: "VOID",
    summary: `Invoice ${inv.invoiceNo} voided: ${reason}`,
    amount: num(inv.total),
    userName: user.name,
  });
}

/** Shape an invoice for the API: adds balance, days past due, discount info. */
export function presentInvoice<T extends Prisma.InvoiceGetPayload<object>>(inv: T, today = new Date()) {
  const item = openItemOf(inv);
  const balance = inv.status === "VOID" ? 0 : balanceDue(item);
  const late = daysPastDue(inv.dueDate, today);
  const discountDeadline =
    item.earlyPayDiscountPct > 0 && item.earlyPayDiscountDays > 0
      ? new Date(inv.issueDate.getTime() + item.earlyPayDiscountDays * 86400000)
      : null;
  return {
    ...inv,
    balance,
    daysPastDue: balance > 0 ? late : 0,
    isOverdue: balance > 0 && late > 0,
    earlyDiscountDeadline: discountDeadline,
    earlyDiscountAvailableNow: balance > 0 && earlyDiscountAvailable(item, today),
    earlyDiscountAmount: round2((item.total * item.earlyPayDiscountPct) / 100),
  };
}
