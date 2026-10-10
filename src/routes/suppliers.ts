// Suppliers: contact info, contract terms (15/30/45 days), discounts, late fees.
import { Router } from "express";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { allow } from "../middleware/auth.js";
import { HttpError, badRequest, idParam, notFound, parse, route, onlySent } from "../lib/http.js";
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
  paymentTermsDays: z.coerce.number().int().min(0).max(365).default(0),
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
      // Deleted (inactive) suppliers are left out unless ?all=1
      where: {
        ...(q ? { name: { contains: q, mode: "insensitive" as const } } : {}),
        ...(req.query.all === "1" ? {} : { active: true }),
      },
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
      // A deleted supplier's name can be used again: that record comes back with the new details
      const same = await tx.supplier.findFirst({ where: { name: { equals: input.name, mode: "insensitive" } } });
      if (same?.active) throw new HttpError(409, `There is already a supplier called "${same.name}".`);
      const s = same
        ? await tx.supplier.update({ where: { id: same.id }, data: { ...input, active: true } })
        : await tx.supplier.create({ data: input });
      await logActivity(tx, {
        entityType: "Supplier",
        entityId: s.id,
        entityRef: s.name,
        action: "CREATED",
        summary: `Supplier ${s.name} added (${s.paymentTermsDays > 0 ? `net ${s.paymentTermsDays}` : "due on receipt"})`,
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

/** What deleting this supplier would do — shown in the confirm box. */
async function deleteCheck(db: Prisma.TransactionClient, id: number) {
  const supplier = await db.supplier.findUnique({ where: { id } });
  if (!supplier) throw notFound("Supplier");
  const [items, orders, waiting, bills, payments, open] = await Promise.all([
    db.product.count({ where: { supplierId: id, deletedAt: null } }),
    db.purchaseOrder.count({ where: { supplierId: id } }),
    db.purchaseOrder.count({ where: { supplierId: id, status: "ORDERED" } }),
    db.supplierBill.count({ where: { supplierId: id } }),
    db.supplierPayment.count({ where: { supplierId: id } }),
    db.supplierBill.findMany({ where: { supplierId: id, status: { in: ["OPEN", "PARTIAL"] } } }),
  ]);
  const owed = round2(open.map((b) => presentBill(b)).reduce((t, b) => t + b.balance, 0));
  const hasHistory = orders + bills + payments > 0;
  const blockedBy =
    owed > 0
      ? `We still owe ${supplier.name} $${owed.toFixed(2)}. Pay or void the open bills first.`
      : waiting > 0
        ? `${waiting} purchase order${waiting === 1 ? " is" : "s are"} still waiting for delivery from ${supplier.name}. Receive or cancel ${waiting === 1 ? "it" : "them"} first.`
        : null;
  return { supplier, items, orders, bills, payments, owed, hasHistory, blockedBy };
}

router.get(
  "/:id/delete-check",
  allow("MANAGER", "ACCOUNTANT"),
  route(async (req, res) => {
    const c = await deleteCheck(req.db, idParam(req));
    res.json({ name: c.supplier.name, items: c.items, orders: c.orders, bills: c.bills, payments: c.payments, owed: c.owed, keepsHistory: c.hasHistory, blockedBy: c.blockedBy });
  })
);

/**
 * Delete a supplier. Its items are kept but no longer show a supplier.
 * A supplier we've never ordered from is removed completely; one with purchase
 * orders, bills or payments is taken off every list but kept so that history,
 * A/P and the books still show it. Refused while we owe them money or an order
 * is still waiting for delivery.
 */
router.delete(
  "/:id",
  allow("MANAGER", "ACCOUNTANT"),
  route(async (req, res) => {
    const id = idParam(req);
    await req.db.$transaction(async (tx) => {
      const c = await deleteCheck(tx, id);
      if (!c.supplier.active && c.hasHistory) throw notFound("Supplier");
      if (c.blockedBy) throw badRequest(c.blockedBy);
      await tx.product.updateMany({ where: { supplierId: id }, data: { supplierId: null } });
      if (c.hasHistory) await tx.supplier.update({ where: { id }, data: { active: false } });
      else await tx.supplier.delete({ where: { id } });
      await logActivity(tx, {
        entityType: "Supplier",
        entityId: id,
        entityRef: c.supplier.name,
        action: "DELETED",
        summary: `Supplier ${c.supplier.name} deleted${c.items ? ` (${c.items} item${c.items === 1 ? "" : "s"} no longer linked)` : ""}${c.hasHistory ? "; past orders and bills kept" : ""}`,
        userName: req.user.name,
      });
    });
    res.json({ ok: true });
  })
);

export default router;
