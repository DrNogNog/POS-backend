// Suppliers: contact info, contract terms (15/30/45 days), discounts, late fees.
import { Router } from "express";
import { z } from "zod";
import { allow } from "../middleware/auth.js";
import { idParam, notFound, parse, route, onlySent } from "../lib/http.js";
import { diffFields, logActivity } from "../lib/history.js";
import { num, round2 } from "../lib/money.js";
import { presentBill } from "../services/purchasing.js";

const router = Router();

const supplierSchema = z.object({
  name: z.string().trim().min(1, "Name is required"),
  contactName: z.string().trim().default(""),
  phone: z.string().trim().default(""),
  email: z.string().trim().default(""),
  address: z.string().trim().default(""),
  accountNumber: z.string().trim().default(""),
  paymentTermsDays: z.coerce.number().int().min(0).max(365).default(30),
  tradeDiscountPct: z.coerce.number().min(0).max(100).default(0),
  earlyPayDiscountPct: z.coerce.number().min(0).max(100).default(0),
  earlyPayDiscountDays: z.coerce.number().int().min(0).max(365).default(0),
  lateFeePct: z.coerce.number().min(0).max(100).default(0),
  lateFeeFlat: z.coerce.number().min(0).default(0),
  contractStart: z.coerce.date().optional().nullable(),
  contractEnd: z.coerce.date().optional().nullable(),
  contractNotes: z.string().trim().default(""),
  rating: z.coerce.number().int().min(1).max(5).optional().nullable(),
  notes: z.string().trim().default(""),
  active: z.boolean().default(true),
});

router.get(
  "/",
  route(async (req, res) => {
    const q = String(req.query.q || "").trim();
    const suppliers = await req.db.supplier.findMany({
      where: q ? { name: { contains: q, mode: "insensitive" } } : {},
      orderBy: { name: "asc" },
      include: { _count: { select: { products: true } } },
    });
    // Open balance per supplier
    const open = await req.db.supplierBill.findMany({
      where: { status: { in: ["OPEN", "PARTIAL"] } },
    });
    const balances = new Map<number, { balance: number; overdue: number }>();
    for (const b of open.map((x) => presentBill(x))) {
      const row = balances.get(b.supplierId) ?? { balance: 0, overdue: 0 };
      row.balance = round2(row.balance + b.balance);
      if (b.isOverdue) row.overdue = round2(row.overdue + b.balance);
      balances.set(b.supplierId, row);
    }
    res.json(
      suppliers.map((s) => ({
        ...s,
        productCount: s._count.products,
        balance: balances.get(s.id)?.balance ?? 0,
        overdue: balances.get(s.id)?.overdue ?? 0,
      }))
    );
  })
);

router.get(
  "/:id",
  route(async (req, res) => {
    const id = idParam(req);
    const supplier = await req.db.supplier.findUnique({
      where: { id },
      include: {
        bills: { orderBy: { billDate: "desc" }, take: 200 },
        purchaseOrders: { orderBy: { orderDate: "desc" }, take: 100 },
        payments: { orderBy: { date: "desc" }, take: 100 },
        products: {
          where: { deletedAt: null },
          select: { id: true, itemCode: true, name: true, listPrice: true, unitCost: true, qtyOnHand: true },
          orderBy: { itemCode: "asc" },
          take: 500,
        },
      },
    });
    if (!supplier) throw notFound("Supplier");
    const bills = supplier.bills.map((b) => presentBill(b));
    const totalPurchased = round2(bills.filter((b) => b.status !== "VOID").reduce((s, b) => s + num(b.total), 0));
    const discountsSaved = round2(
      bills.reduce((s, b) => s + num(b.tradeDiscount) + num(b.discountsTaken), 0)
    );
    const lateFeesPaid = round2(bills.reduce((s, b) => s + num(b.lateFees), 0));
    const paidOnTime = bills.filter((b) => b.status === "PAID").length;
    res.json({
      ...supplier,
      bills,
      stats: {
        totalPurchased,
        discountsSaved,
        lateFeesPaid,
        openBalance: round2(bills.reduce((s, b) => s + b.balance, 0)),
        billsPaid: paidOnTime,
      },
    });
  })
);

router.post(
  "/",
  allow("MANAGER", "ACCOUNTANT"),
  route(async (req, res) => {
    const input = parse(supplierSchema, req.body);
    const supplier = await req.db.$transaction(async (tx) => {
      const s = await tx.supplier.create({ data: input });
      await logActivity(tx, {
        entityType: "Supplier",
        entityId: s.id,
        entityRef: s.name,
        action: "CREATED",
        summary: `Supplier ${s.name} added (net ${s.paymentTermsDays})`,
        userName: req.user.name,
      });
      return s;
    });
    res.status(201).json(supplier);
  })
);

router.put(
  "/:id",
  allow("MANAGER", "ACCOUNTANT"),
  route(async (req, res) => {
    const id = idParam(req);
    const input = onlySent(parse(supplierSchema.partial(), req.body), req.body);
    const supplier = await req.db.$transaction(async (tx) => {
      const before = await tx.supplier.findUnique({ where: { id } });
      if (!before) throw notFound("Supplier");
      const after = await tx.supplier.update({ where: { id }, data: input });
      const changes = diffFields(before as never, after as never);
      if (Object.keys(changes).length) {
        await logActivity(tx, {
          entityType: "Supplier",
          entityId: id,
          entityRef: after.name,
          action: "UPDATED",
          summary: `Supplier ${after.name} updated: ${Object.keys(changes).join(", ")}`,
          details: JSON.parse(JSON.stringify(changes)),
          userName: req.user.name,
        });
      }
      return after;
    });
    res.json(supplier);
  })
);

export default router;
