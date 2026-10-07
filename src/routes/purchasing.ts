// Purchase orders, supplier bills (billing orders) and the A/P board.
import { Router } from "express";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { allow, BOOKKEEPERS } from "../middleware/auth.js";
import { idParam, notFound, parse, route } from "../lib/http.js";
import { num } from "../lib/money.js";
import {
  addBillLateFee,
  cancelPo,
  createExpenseBill,
  markPoOrdered,
  presentBill,
  receivePurchaseOrder,
  recordSupplierPayment,
  savePurchaseOrder,
} from "../services/purchasing.js";
import { payablesBoard } from "../services/reports.js";
import { getSettings } from "../services/settings.js";
import { orderBy, paymentMethod, sendPdf } from "./_shared.js";

const BUYERS = ["MANAGER", "ACCOUNTANT"] as const;

// ============================================================================
// PURCHASE ORDERS  (/api/purchase-orders)
// ============================================================================
export const purchaseOrdersRouter = Router();

const poSchema = z.object({
  supplierId: z.coerce.number().int().positive("Choose a supplier"),
  expectedDate: z.coerce.date().optional().nullable(),
  notes: z.string().trim().default(""),
  lines: z
    .array(
      z.object({
        productId: z.coerce.number().int().positive(),
        qty: z.coerce.number().positive(),
        listPrice: z.coerce.number().min(0).optional().nullable(),
        discountPct: z.coerce.number().min(0).max(100).optional().nullable(),
      })
    )
    .min(1, "Add at least one item"),
});

purchaseOrdersRouter.get(
  "/",
  route(async (req, res) => {
    const where: Prisma.PurchaseOrderWhereInput = {};
    if (req.query.status) where.status = String(req.query.status) as never;
    if (req.query.supplierId) where.supplierId = Number(req.query.supplierId);
    res.json(
      await req.db.purchaseOrder.findMany({
        where,
        orderBy: orderBy(req, ["orderDate", "subtotal", "poNo"] as const, "orderDate"),
        include: { supplier: { select: { id: true, name: true } }, _count: { select: { lines: true } } },
        take: 500,
      })
    );
  })
);

purchaseOrdersRouter.get(
  "/:id",
  route(async (req, res) => {
    const po = await req.db.purchaseOrder.findUnique({
      where: { id: idParam(req) },
      include: {
        supplier: true,
        lines: { include: { product: { select: { id: true, itemCode: true, name: true, unit: true } } } },
        bills: true,
      },
    });
    if (!po) throw notFound("Purchase order");
    res.json(po);
  })
);

purchaseOrdersRouter.post(
  "/",
  allow(...BUYERS),
  route(async (req, res) => {
    const input = parse(poSchema, req.body);
    res.status(201).json(await req.db.$transaction((tx) => savePurchaseOrder(tx, input, req.user)));
  })
);

purchaseOrdersRouter.put(
  "/:id",
  allow(...BUYERS),
  route(async (req, res) => {
    const input = parse(poSchema, req.body);
    res.json(await req.db.$transaction((tx) => savePurchaseOrder(tx, { ...input, id: idParam(req) }, req.user)));
  })
);

purchaseOrdersRouter.post(
  "/:id/ordered",
  allow(...BUYERS),
  route(async (req, res) => {
    await req.db.$transaction((tx) => markPoOrdered(tx, idParam(req), req.user));
    res.json({ ok: true });
  })
);

purchaseOrdersRouter.post(
  "/:id/cancel",
  allow(...BUYERS),
  route(async (req, res) => {
    await req.db.$transaction((tx) => cancelPo(tx, idParam(req), req.user));
    res.json({ ok: true });
  })
);

const receiveSchema = z.object({
  billNo: z.string().trim().min(1, "Enter the supplier's invoice number"),
  billDate: z.coerce.date().optional(),
  freight: z.coerce.number().min(0).default(0),
  taxAmount: z.coerce.number().min(0).default(0),
  termsDays: z.coerce.number().int().min(0).max(365).optional().nullable(),
  notes: z.string().trim().default(""),
  lines: z
    .array(
      z.object({
        lineId: z.coerce.number().int().positive(),
        qtyReceived: z.coerce.number().min(0),
        unitCost: z.coerce.number().min(0).optional().nullable(),
      })
    )
    .optional(),
});

purchaseOrdersRouter.post(
  "/:id/receive",
  allow(...BUYERS),
  route(async (req, res) => {
    const input = parse(receiveSchema, req.body);
    const bill = await req.db.$transaction((tx) => receivePurchaseOrder(tx, idParam(req), input, req.user), {
      timeout: 30000,
    });
    res.status(201).json(bill);
  })
);

purchaseOrdersRouter.get(
  "/:id/pdf",
  route(async (req, res) => {
    const po = await req.db.purchaseOrder.findUnique({
      where: { id: idParam(req) },
      include: { supplier: true, lines: { include: { product: true } } },
    });
    if (!po) throw notFound("Purchase order");
    const s = await getSettings(req.db);
    await sendPdf(req, res, po.poNo, {
      title: "PURCHASE ORDER",
      number: po.poNo,
      date: po.orderDate,
      dueDate: po.expectedDate,
      terms: `Net ${po.supplier.paymentTermsDays}`,
      leftBoxTitle: "Supplier",
      leftBox: [po.supplier.name, po.supplier.contactName, po.supplier.address].filter(Boolean).join("\n"),
      phone: po.supplier.phone,
      rightBoxTitle: "Deliver To",
      rightBox: [s.name, s.address, [s.city, s.state, s.zip].filter(Boolean).join(", ")].filter(Boolean).join("\n"),
      meta: [
        ["Our account #", po.supplier.accountNumber || ""],
        ["Status", po.status.toLowerCase()],
      ],
      signatureLabel: "Authorized by",
      lines: po.lines.map((l) => ({
        itemCode: l.product.itemCode,
        description: `${l.product.name}${num(l.discountPct) > 0 ? ` (list $${num(l.listPrice).toFixed(2)} less ${num(l.discountPct)}%)` : ""}`,
        qty: num(l.qty),
        unitPrice: num(l.unitCost),
        lineTotal: num(l.lineTotal),
      })),
      totals: [["TOTAL", num(po.subtotal), true]],
      footerNote: po.notes,
    });
  })
);

// ============================================================================
// SUPPLIER BILLS / BILLING ORDERS  (/api/bills)
// ============================================================================
export const billsRouter = Router();

billsRouter.get(
  "/",
  route(async (req, res) => {
    const where: Prisma.SupplierBillWhereInput = {};
    const status = String(req.query.status || "");
    if (status === "UNPAID") where.status = { in: ["OPEN", "PARTIAL"] };
    else if (status) where.status = status as never;
    if (req.query.supplierId) where.supplierId = Number(req.query.supplierId);
    const bills = await req.db.supplierBill.findMany({
      where,
      orderBy: orderBy(req, ["billDate", "dueDate", "total"] as const, "billDate"),
      include: {
        supplier: { select: { id: true, name: true } },
        purchaseOrder: { select: { id: true, poNo: true } },
      },
      take: 1000,
    });
    res.json(bills.map((b) => presentBill(b)));
  })
);

billsRouter.get(
  "/:id",
  route(async (req, res) => {
    const bill = await req.db.supplierBill.findUnique({
      where: { id: idParam(req) },
      include: {
        supplier: true,
        purchaseOrder: { select: { id: true, poNo: true } },
        lines: true,
        payments: { orderBy: { date: "asc" } },
        adjustments: true,
      },
    });
    if (!bill) throw notFound("Bill");
    res.json(presentBill(bill));
  })
);

billsRouter.post(
  "/",
  allow(...BOOKKEEPERS),
  route(async (req, res) => {
    const input = parse(
      z.object({
        supplierId: z.coerce.number().int().positive("Choose a supplier"),
        billNo: z.string().trim().min(1, "Enter the bill number"),
        billDate: z.coerce.date().optional(),
        termsDays: z.coerce.number().int().min(0).max(365).optional().nullable(),
        expenseAccountCode: z.string().trim().min(1),
        amount: z.coerce.number().positive(),
        notes: z.string().trim().default(""),
      }),
      req.body
    );
    res.status(201).json(await req.db.$transaction((tx) => createExpenseBill(tx, input, req.user)));
  })
);

billsRouter.post(
  "/:id/payments",
  allow(...BOOKKEEPERS),
  route(async (req, res) => {
    const input = parse(
      z.object({
        amount: z.coerce.number().positive("Enter an amount"),
        method: paymentMethod,
        reference: z.string().trim().default(""),
        notes: z.string().trim().default(""),
        date: z.coerce.date().optional(),
        takeDiscount: z.boolean().default(true),
      }),
      req.body
    );
    res.status(201).json(await req.db.$transaction((tx) => recordSupplierPayment(tx, idParam(req), input, req.user)));
  })
);

billsRouter.post(
  "/:id/late-fee",
  allow(...BOOKKEEPERS),
  route(async (req, res) => {
    const input = parse(
      z.object({ amount: z.coerce.number().min(0).optional().nullable(), note: z.string().trim().default("") }),
      req.body ?? {}
    );
    res.json(await req.db.$transaction((tx) => addBillLateFee(tx, idParam(req), input, req.user)));
  })
);

billsRouter.get(
  "/:id/pdf",
  route(async (req, res) => {
    const bill = await req.db.supplierBill.findUnique({
      where: { id: idParam(req) },
      include: { supplier: true, lines: true, purchaseOrder: true },
    });
    if (!bill) throw notFound("Bill");
    const p = presentBill(bill);
    const totals: [string, number, boolean?][] = [["Goods", num(bill.subtotal)]];
    if (num(bill.tradeDiscount) > 0) totals.unshift(["Supplier discount saved", num(bill.tradeDiscount)]);
    if (num(bill.freight) > 0) totals.push(["Freight", num(bill.freight)]);
    if (num(bill.taxAmount) > 0) totals.push(["Tax", num(bill.taxAmount)]);
    totals.push(["TOTAL", num(bill.total), true]);
    if (num(bill.lateFees) > 0) totals.push(["Late fees", num(bill.lateFees)]);
    if (num(bill.amountPaid) > 0) totals.push(["Paid", -num(bill.amountPaid)]);
    if (num(bill.discountsTaken) > 0) totals.push(["Early-pay discount", -num(bill.discountsTaken)]);
    totals.push(["BALANCE DUE", p.balance, true]);
    await sendPdf(req, res, `Bill-${bill.billNo}`, {
      title: "BILLING ORDER",
      number: bill.billNo,
      date: bill.billDate,
      dueDate: bill.dueDate,
      terms: `Net ${bill.termsDays}`,
      leftBoxTitle: "Supplier",
      leftBox: [bill.supplier.name, bill.supplier.address].filter(Boolean).join("\n"),
      phone: bill.supplier.phone,
      rightBoxTitle: "Reference",
      rightBox: [bill.purchaseOrder ? `PO ${bill.purchaseOrder.poNo}` : "No purchase order", `Account ${bill.expenseAccountCode}`].join("\n"),
      lines: bill.lines.length
        ? bill.lines.map((l) => ({
            itemCode: l.itemCode,
            description: l.description,
            qty: num(l.qty),
            unitPrice: num(l.unitCost),
            lineTotal: num(l.lineTotal),
          }))
        : [{ itemCode: "", description: bill.notes || "Expense", qty: 1, unitPrice: num(bill.subtotal), lineTotal: num(bill.subtotal) }],
      totals,
      footerNote: bill.notes,
    });
  })
);

// ============================================================================
// A/P BOARD  (/api/payables)
// ============================================================================
export const payablesRouter = Router();
payablesRouter.get(
  "/",
  route(async (req, res) => {
    res.json(await payablesBoard(req.db));
  })
);
