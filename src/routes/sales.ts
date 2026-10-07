// Estimates, approvals, invoices, payments and the A/R board.
import { Router } from "express";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { allow, BOOKKEEPERS } from "../middleware/auth.js";
import { idParam, notFound, parse, route } from "../lib/http.js";
import { num } from "../lib/money.js";
import {
  addInvoiceLateFee,
  createInvoice,
  invoiceFromEstimate,
  presentInvoice,
  recordCustomerPayment,
  saveEstimate,
  sendToCollections,
  setEstimateStatus,
  voidInvoice,
  writeOffInvoice,
} from "../services/sales.js";
import { receivablesBoard } from "../services/reports.js";
import { fulfillment, lineSchema, orderBy, pageParams, paymentMethod, sendPdf } from "./_shared.js";

// ============================================================================
// ESTIMATES  (/api/estimates)
// ============================================================================
export const estimatesRouter = Router();

const documentSchema = z.object({
  // Every sale and estimate belongs to a customer (walk-ins get a quick customer record)
  customerId: z.coerce
    .number({ message: "Pick a customer for this sale" })
    .int()
    .positive("Pick a customer for this sale"),
  billTo: z.string().trim().default(""),
  shipTo: z.string().trim().default(""),
  /** Printed in their own boxes on the PDF. Empty = the customer's own number. */
  phone: z.string().trim().default(""),
  fax: z.string().trim().default(""),
  fulfillment: fulfillment.default("PICKUP"),
  priceTierCode: z.string().trim().default("AA"),
  discountAmount: z.coerce.number().min(0).default(0),
  taxRatePct: z.coerce.number().min(0).max(30).optional().nullable(),
  notes: z.string().trim().default(""),
  lines: z.array(lineSchema).min(1, "Add at least one line item"),
  /** Save an estimate even if stock (after other estimates) is short. */
  allowShortage: z.boolean().default(false),
});

estimatesRouter.get(
  "/",
  route(async (req, res) => {
    const where: Prisma.EstimateWhereInput = {};
    if (req.query.status) where.status = String(req.query.status) as never;
    if (req.query.customerId) where.customerId = Number(req.query.customerId);
    const q = String(req.query.q || "").trim();
    if (q) where.OR = [{ estimateNo: { contains: q, mode: "insensitive" } }, { billTo: { contains: q, mode: "insensitive" } }];
    const list = await req.db.estimate.findMany({
      where,
      orderBy: orderBy(req, ["date", "total", "estimateNo"] as const, "date"),
      include: { customer: { select: { id: true, name: true } }, invoice: { select: { id: true, invoiceNo: true } } },
      take: 500,
    });
    res.json(list);
  })
);

estimatesRouter.get(
  "/:id",
  route(async (req, res) => {
    const est = await req.db.estimate.findUnique({
      where: { id: idParam(req) },
      include: { lines: { orderBy: { sortOrder: "asc" } }, customer: true, invoice: { select: { id: true, invoiceNo: true } } },
    });
    if (!est) throw notFound("Estimate");
    res.json(est);
  })
);

estimatesRouter.post(
  "/",
  route(async (req, res) => {
    const input = parse(documentSchema, req.body);
    const est = await req.db.$transaction((tx) => saveEstimate(tx, input, req.user));
    res.status(201).json(est);
  })
);

estimatesRouter.put(
  "/:id",
  route(async (req, res) => {
    const input = parse(documentSchema, req.body);
    const est = await req.db.$transaction((tx) => saveEstimate(tx, { ...input, id: idParam(req) }, req.user));
    res.json(est);
  })
);

estimatesRouter.post(
  "/:id/status",
  route(async (req, res) => {
    const { status } = parse(z.object({ status: z.enum(["APPROVED", "REJECTED", "PENDING"]) }), req.body);
    const est = await req.db.$transaction((tx) => setEstimateStatus(tx, idParam(req), status, req.user));
    res.json(est);
  })
);

estimatesRouter.post(
  "/:id/invoice",
  route(async (req, res) => {
    const opts = parse(
      z.object({
        termsDays: z.coerce.number().int().min(0).max(365).optional().nullable(),
        allowBackorder: z.boolean().default(false),
      }),
      req.body ?? {}
    );
    const inv = await req.db.$transaction((tx) => invoiceFromEstimate(tx, idParam(req), opts, req.user), {
      timeout: 30000,
    });
    res.status(201).json(inv);
  })
);

estimatesRouter.get(
  "/:id/pdf",
  route(async (req, res) => {
    const est = await req.db.estimate.findUnique({
      where: { id: idParam(req) },
      include: { lines: { orderBy: { sortOrder: "asc" } } },
    });
    if (!est) throw notFound("Estimate");
    const totals: [string, number, boolean?][] = [["Subtotal", num(est.subtotal)]];
    if (num(est.discountAmount) > 0) totals.push(["Discount", -num(est.discountAmount)]);
    totals.push([`Tax (${num(est.taxRatePct)}%)`, num(est.taxAmount)], ["TOTAL", num(est.total), true]);
    await sendPdf(req, res, est.estimateNo, {
      title: "ESTIMATE",
      number: est.estimateNo,
      date: est.date,
      leftBoxTitle: "Bill To",
      leftBox: est.billTo,
      rightBoxTitle: est.fulfillment === "DELIVERY" ? "Deliver To" : "Ship To / Pickup",
      rightBox: est.fulfillment === "DELIVERY" ? est.shipTo || est.billTo : est.shipTo || "Customer pickup",
      phone: est.phone,
      fax: est.fax,
      // Price levels are internal, so they are never printed on customer documents
      meta: [
        ["Prepared by", est.createdBy],
        ["Fulfillment", est.fulfillment === "DELIVERY" ? "Delivery" : "Pickup"],
        ["Status", est.status === "PENDING" ? "Awaiting approval" : est.status.toLowerCase()],
      ],
      signatureLabel: "Customer approval",
      lines: est.lines.map((l) => ({
        itemCode: l.itemCode,
        description: l.description,
        qty: num(l.qty),
        unitPrice: num(l.unitPrice),
        lineTotal: num(l.lineTotal),
      })),
      totals,
      footerNote: est.notes || "This estimate is valid for 30 days. Prices subject to change after expiry.",
    });
  })
);

// ============================================================================
// INVOICES  (/api/invoices)
// ============================================================================
export const invoicesRouter = Router();

invoicesRouter.get(
  "/",
  route(async (req, res) => {
    const where: Prisma.InvoiceWhereInput = {};
    const status = String(req.query.status || "");
    if (status === "UNPAID") where.status = { in: ["OPEN", "PARTIAL"] };
    else if (status) where.status = status as never;
    if (req.query.customerId) where.customerId = Number(req.query.customerId);
    if (req.query.collectionStatus) where.collectionStatus = String(req.query.collectionStatus) as never;
    // approval=needed → came from an approved estimate; approval=none → direct sale
    if (req.query.approval === "needed") where.estimateId = { not: null };
    else if (req.query.approval === "none") where.estimateId = null;
    if (req.query.from || req.query.to) {
      where.issueDate = {
        ...(req.query.from ? { gte: new Date(String(req.query.from)) } : {}),
        ...(req.query.to ? { lte: new Date(String(req.query.to) + "T23:59:59") } : {}),
      };
    }
    const q = String(req.query.q || "").trim();
    if (q) {
      where.OR = [
        { invoiceNo: { contains: q, mode: "insensitive" } },
        { billTo: { contains: q, mode: "insensitive" } },
        { customer: { name: { contains: q, mode: "insensitive" } } },
      ];
    }
    const { take, skip, page, limit } = pageParams(req, 100);
    const [rows, total] = await Promise.all([
      req.db.invoice.findMany({
        where,
        take,
        skip,
        orderBy: orderBy(req, ["issueDate", "dueDate", "total", "invoiceNo"] as const, "issueDate"),
        include: {
          customer: { select: { id: true, name: true } },
          estimate: { select: { id: true, estimateNo: true, approvedAt: true } },
        },
      }),
      req.db.invoice.count({ where }),
    ]);
    let items = rows.map((r) => presentInvoice(r));
    if (req.query.overdue === "true") items = items.filter((i) => i.isOverdue);
    res.json({ items, total, page, limit });
  })
);

invoicesRouter.get(
  "/:id",
  route(async (req, res) => {
    const inv = await req.db.invoice.findUnique({
      where: { id: idParam(req) },
      include: {
        lines: { orderBy: { sortOrder: "asc" } },
        payments: { orderBy: { date: "asc" } },
        adjustments: { orderBy: { createdAt: "asc" } },
        customer: true,
        estimate: { select: { id: true, estimateNo: true } },
      },
    });
    if (!inv) throw notFound("Invoice");
    res.json(presentInvoice(inv));
  })
);

const invoiceSchema = documentSchema.extend({
  /** Leave empty for today. Set it to enter an older invoice. */
  issueDate: z.coerce.date().optional(),
  termsDays: z.coerce.number().int().min(0).max(365).optional().nullable(),
  salesperson: z.string().trim().default(""),
  allowBackorder: z.boolean().default(false),
  payment: z
    .object({ amount: z.coerce.number().min(0), method: paymentMethod, reference: z.string().trim().default("") })
    .optional()
    .nullable(),
});

/** Direct sale (register): invoice + optional payment in one step. */
invoicesRouter.post(
  "/",
  route(async (req, res) => {
    const input = parse(invoiceSchema, req.body);
    const inv = await req.db.$transaction((tx) => createInvoice(tx, input, req.user), { timeout: 30000 });
    res.status(201).json(inv);
  })
);

const paymentSchema = z.object({
  amount: z.coerce.number().positive("Enter an amount"),
  method: paymentMethod,
  reference: z.string().trim().default(""),
  notes: z.string().trim().default(""),
  date: z.coerce.date().optional(),
  takeDiscount: z.boolean().default(true),
});

invoicesRouter.post(
  "/:id/payments",
  route(async (req, res) => {
    const input = parse(paymentSchema, req.body);
    const result = await req.db.$transaction((tx) => recordCustomerPayment(tx, idParam(req), input, req.user));
    res.status(201).json(result);
  })
);

invoicesRouter.post(
  "/:id/late-fee",
  allow(...BOOKKEEPERS),
  route(async (req, res) => {
    const input = parse(
      z.object({ amount: z.coerce.number().min(0).optional().nullable(), note: z.string().trim().default("") }),
      req.body ?? {}
    );
    res.json(await req.db.$transaction((tx) => addInvoiceLateFee(tx, idParam(req), input, req.user)));
  })
);

invoicesRouter.post(
  "/:id/collections",
  allow(...BOOKKEEPERS),
  route(async (req, res) => {
    const { note } = parse(z.object({ note: z.string().trim().default("") }), req.body ?? {});
    await req.db.$transaction((tx) => sendToCollections(tx, idParam(req), note, req.user));
    res.json({ ok: true });
  })
);

invoicesRouter.post(
  "/:id/write-off",
  allow(...BOOKKEEPERS),
  route(async (req, res) => {
    const { note } = parse(z.object({ note: z.string().trim().default("") }), req.body ?? {});
    await req.db.$transaction((tx) => writeOffInvoice(tx, idParam(req), note, req.user));
    res.json({ ok: true });
  })
);

invoicesRouter.post(
  "/:id/void",
  allow("MANAGER"),
  route(async (req, res) => {
    const { reason } = parse(z.object({ reason: z.string().trim().min(1, "Give a reason") }), req.body ?? {});
    await req.db.$transaction((tx) => voidInvoice(tx, idParam(req), reason, req.user), { timeout: 30000 });
    res.json({ ok: true });
  })
);

invoicesRouter.put(
  "/:id/due-date",
  allow(...BOOKKEEPERS),
  route(async (req, res) => {
    const { dueDate } = parse(z.object({ dueDate: z.coerce.date() }), req.body);
    const id = idParam(req);
    const inv = await req.db.$transaction(async (tx) => {
      const before = await tx.invoice.findUnique({ where: { id } });
      if (!before) throw notFound("Invoice");
      const after = await tx.invoice.update({ where: { id }, data: { dueDate } });
      await tx.activityLog.create({
        data: {
          entityType: "Invoice",
          entityId: id,
          entityRef: before.invoiceNo,
          action: "DUE_DATE",
          summary: `Due date of ${before.invoiceNo} changed from ${before.dueDate.toISOString().slice(0, 10)} to ${dueDate
            .toISOString()
            .slice(0, 10)}`,
          userName: req.user.name,
        },
      });
      return after;
    });
    res.json(inv);
  })
);

invoicesRouter.get(
  "/:id/pdf",
  route(async (req, res) => {
    const inv = await req.db.invoice.findUnique({
      where: { id: idParam(req) },
      include: { lines: { orderBy: { sortOrder: "asc" } } },
    });
    if (!inv) throw notFound("Invoice");
    const p = presentInvoice(inv);
    const totals: [string, number, boolean?][] = [["Subtotal", num(inv.subtotal)]];
    if (num(inv.discountAmount) > 0) totals.push(["Discount", -num(inv.discountAmount)]);
    totals.push([`Tax (${num(inv.taxRatePct)}%)`, num(inv.taxAmount)], ["TOTAL", num(inv.total), true]);
    if (num(inv.lateFees) > 0) totals.push(["Late fees", num(inv.lateFees)]);
    if (num(inv.amountPaid) > 0) totals.push(["Paid", -num(inv.amountPaid)]);
    if (num(inv.discountsTaken) > 0) totals.push(["Early-pay discount", -num(inv.discountsTaken)]);
    if (num(inv.writtenOff) > 0) totals.push(["Written off", -num(inv.writtenOff)]);
    totals.push(["BALANCE DUE", p.balance, true]);
    const pct = num(inv.earlyPayDiscountPct);
    await sendPdf(req, res, inv.invoiceNo, {
      title: "INVOICE",
      number: inv.invoiceNo,
      date: inv.issueDate,
      dueDate: inv.dueDate,
      terms:
        inv.termsDays === 0
          ? "Due on receipt"
          : pct > 0
            ? `${pct}/${inv.earlyPayDiscountDays} net ${inv.termsDays}`
            : `Net ${inv.termsDays}`,
      leftBoxTitle: "Bill To",
      leftBox: inv.billTo,
      rightBoxTitle: inv.fulfillment === "DELIVERY" ? "Deliver To" : "Ship To / Pickup",
      rightBox: inv.fulfillment === "DELIVERY" ? inv.shipTo || inv.billTo : inv.shipTo || "Customer pickup",
      phone: inv.phone,
      fax: inv.fax,
      meta: [
        ["Salesperson", inv.salesperson],
        ["Fulfillment", inv.fulfillment === "DELIVERY" ? "Delivery" : "Pickup"],
        ["Status", inv.status === "VOID" ? "VOID" : inv.status === "PARTIAL" ? "Partly paid" : inv.status.toLowerCase()],
      ],
      signatureLabel: "Received by",
      lines: inv.lines.map((l) => ({
        itemCode: l.itemCode,
        description: l.description,
        qty: num(l.qty),
        unitPrice: num(l.unitPrice),
        lineTotal: num(l.lineTotal),
      })),
      totals,
      footerNote:
        (pct > 0 && p.earlyDiscountDeadline
          ? `Pay by ${p.earlyDiscountDeadline.toLocaleDateString("en-US")} and take ${pct}% off ($${p.earlyDiscountAmount.toFixed(2)}). `
          : "") + (inv.notes || "Thank you for your business!"),
      style: "plain", // invoices print as a normal black & white document
    });
  })
);

// ============================================================================
// A/R BOARD  (/api/receivables)
// ============================================================================
export const receivablesRouter = Router();
receivablesRouter.get(
  "/",
  route(async (req, res) => {
    res.json(await receivablesBoard(req.db));
  })
);
