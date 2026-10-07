// Customers: remembered details (pickup/delivery, addresses, card on file,
// price tier, terms) and their invoice history, sortable by date.
import { Router } from "express";
import { z } from "zod";
import { idParam, notFound, parse, route, onlySent } from "../lib/http.js";
import { diffFields, logActivity } from "../lib/history.js";
import { num, round2 } from "../lib/money.js";
import { daysBetween } from "../lib/dates.js";
import { presentInvoice } from "../services/sales.js";
import { orderBy } from "./_shared.js";

const router = Router();

const customerSchema = z.object({
  name: z.string().trim().min(1, "Name is required"),
  company: z.string().trim().default(""),
  phone: z.string().trim().default(""),
  fax: z.string().trim().default(""),
  email: z.string().trim().default(""),
  billingAddress: z.string().trim().default(""),
  shippingAddress: z.string().trim().default(""),
  fulfillment: z.enum(["PICKUP", "DELIVERY"]).default("PICKUP"),
  deliveryNotes: z.string().trim().default(""),
  priceTierCode: z.string().trim().default("AA"),
  termsDays: z.coerce.number().int().min(0).max(365).default(0),
  creditLimit: z.coerce.number().min(0).default(0),
  taxExempt: z.boolean().default(false),
  taxExemptId: z.string().trim().default(""),
  // Card on file: brand / last 4 / expiry / processor token only — never the full number.
  cardBrand: z.string().trim().max(20).default(""),
  cardLast4: z
    .string()
    .trim()
    .regex(/^(\d{4})?$/, "Only the LAST 4 digits of a card may be saved")
    .default(""),
  cardExp: z.string().trim().regex(/^((0[1-9]|1[0-2])\/\d{2})?$/, "Expiry must be MM/YY").default(""),
  cardToken: z.string().trim().max(200).default(""),
  notes: z.string().trim().default(""),
  active: z.boolean().default(true),
});

router.get(
  "/",
  route(async (req, res) => {
    const q = String(req.query.q || "").trim();
    const customers = await req.db.customer.findMany({
      where: q
        ? {
            OR: [
              { name: { contains: q, mode: "insensitive" } },
              { company: { contains: q, mode: "insensitive" } },
              { phone: { contains: q } },
              { email: { contains: q, mode: "insensitive" } },
            ],
          }
        : {},
      orderBy: { name: "asc" },
      take: q ? 25 : 500,
    });
    const open = await req.db.invoice.findMany({
      where: { status: { in: ["OPEN", "PARTIAL"] }, customerId: { in: customers.map((c) => c.id) } },
    });
    const last = await req.db.invoice.groupBy({
      by: ["customerId"],
      _max: { issueDate: true },
      _sum: { total: true },
      where: { customerId: { in: customers.map((c) => c.id) }, status: { not: "VOID" } },
    });
    const balances = new Map<number, number>();
    for (const inv of open.map((i) => presentInvoice(i))) {
      balances.set(inv.customerId!, round2((balances.get(inv.customerId!) ?? 0) + inv.balance));
    }
    const lastBy = new Map(last.map((l) => [l.customerId, l]));
    res.json(
      customers.map((c) => ({
        ...c,
        cardToken: c.cardToken ? "on file" : "",
        balance: balances.get(c.id) ?? 0,
        lastPurchase: lastBy.get(c.id)?._max.issueDate ?? null,
        lifetimeSales: num(lastBy.get(c.id)?._sum.total),
      }))
    );
  })
);

router.get(
  "/:id",
  route(async (req, res) => {
    const id = idParam(req);
    const sort = orderBy(req, ["issueDate", "dueDate", "total", "invoiceNo"] as const, "issueDate", "desc");
    const customer = await req.db.customer.findUnique({
      where: { id },
      include: {
        invoices: { orderBy: sort, include: { payments: { orderBy: { date: "asc" } } } },
        estimates: { orderBy: { date: "desc" }, take: 50 },
      },
    });
    if (!customer) throw notFound("Customer");
    const invoices = customer.invoices.map((i) => presentInvoice(i));
    const live = invoices.filter((i) => i.status !== "VOID");
    // Average days to pay (paid invoices, using last payment date)
    const paidDays = live
      .filter((i) => i.status === "PAID" && i.payments.length)
      .map((i) => daysBetween(i.issueDate, i.payments[i.payments.length - 1].date));
    res.json({
      ...customer,
      cardToken: customer.cardToken ? "on file" : "",
      invoices,
      stats: {
        lifetimeSales: round2(live.reduce((s, i) => s + num(i.total), 0)),
        openBalance: round2(live.reduce((s, i) => s + i.balance, 0)),
        overdueBalance: round2(live.filter((i) => i.isOverdue).reduce((s, i) => s + i.balance, 0)),
        invoiceCount: live.length,
        avgDaysToPay: paidDays.length ? Math.round(paidDays.reduce((a, b) => a + b, 0) / paidDays.length) : null,
        availableCredit:
          num(customer.creditLimit) > 0
            ? round2(num(customer.creditLimit) - live.reduce((s, i) => s + i.balance, 0))
            : null,
      },
    });
  })
);

router.post(
  "/",
  route(async (req, res) => {
    const input = parse(customerSchema, req.body);
    const customer = await req.db.$transaction(async (tx) => {
      const c = await tx.customer.create({ data: input });
      await logActivity(tx, {
        entityType: "Customer",
        entityId: c.id,
        entityRef: c.name,
        action: "CREATED",
        summary: `Customer ${c.name} added`,
        userName: req.user.name,
      });
      return c;
    });
    res.status(201).json(customer);
  })
);

router.put(
  "/:id",
  route(async (req, res) => {
    const id = idParam(req);
    const input = onlySent(parse(customerSchema.partial(), req.body), req.body);
    if (input.cardToken === "on file") delete input.cardToken; // unchanged (masked) token
    const customer = await req.db.$transaction(async (tx) => {
      const before = await tx.customer.findUnique({ where: { id } });
      if (!before) throw notFound("Customer");
      const after = await tx.customer.update({ where: { id }, data: input });
      const changes = diffFields(before as never, after as never, ["updatedAt", "createdAt", "cardToken"]);
      if (Object.keys(changes).length) {
        await logActivity(tx, {
          entityType: "Customer",
          entityId: id,
          entityRef: after.name,
          action: "UPDATED",
          summary: `Customer ${after.name} updated: ${Object.keys(changes).join(", ")}`,
          userName: req.user.name,
        });
      }
      return after;
    });
    res.json(customer);
  })
);

export default router;
