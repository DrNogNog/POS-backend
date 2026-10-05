// Employees and payroll runs.
// Gross pay is calculated; withholdings are entered (from your payroll
// provider), and posting a run records it in the books.
import { Router } from "express";
import { z } from "zod";
import { allow, BOOKKEEPERS } from "../middleware/auth.js";
import { badRequest, idParam, notFound, parse, route, onlySent } from "../lib/http.js";
import { logActivity, diffFields } from "../lib/history.js";
import { num, round2 } from "../lib/money.js";
import { grossPay, netPay, suggestedFica } from "../domain/payroll.js";
import { payrollEntry } from "../domain/accounts.js";
import { postEntry } from "../services/journal.js";
import type { Tx } from "../db/stores.js";

const router = Router();
router.use(allow(...BOOKKEEPERS));

// ---- Employees --------------------------------------------------------------
const employeeSchema = z.object({
  name: z.string().trim().min(1, "Name is required"),
  title: z.string().trim().default(""),
  email: z.string().trim().default(""),
  phone: z.string().trim().default(""),
  payType: z.enum(["HOURLY", "SALARY"]).default("HOURLY"),
  payRate: z.coerce.number().min(0),
  payFrequency: z.enum(["WEEKLY", "BIWEEKLY", "SEMIMONTHLY", "MONTHLY"]).default("BIWEEKLY"),
  hireDate: z.coerce.date().optional().nullable(),
  active: z.boolean().default(true),
  notes: z.string().trim().default(""),
});

router.get("/employees", route(async (req, res) => {
  res.json(await req.db.employee.findMany({ orderBy: [{ active: "desc" }, { name: "asc" }] }));
}));

router.post("/employees", route(async (req, res) => {
  const input = parse(employeeSchema, req.body);
  const emp = await req.db.$transaction(async (tx) => {
    const e = await tx.employee.create({ data: input });
    await logActivity(tx, {
      entityType: "Employee",
      entityId: e.id,
      entityRef: e.name,
      action: "CREATED",
      summary: `Employee ${e.name} added (${e.payType.toLowerCase()} $${num(e.payRate).toFixed(2)})`,
      userName: req.user.name,
    });
    return e;
  });
  res.status(201).json(emp);
}));

router.put("/employees/:id", route(async (req, res) => {
  const id = idParam(req);
  const input = onlySent(parse(employeeSchema.partial(), req.body), req.body);
  const emp = await req.db.$transaction(async (tx) => {
    const before = await tx.employee.findUnique({ where: { id } });
    if (!before) throw notFound("Employee");
    const after = await tx.employee.update({ where: { id }, data: input });
    const changes = diffFields(before as never, after as never);
    if (Object.keys(changes).length) {
      await logActivity(tx, {
        entityType: "Employee",
        entityId: id,
        entityRef: after.name,
        action: "UPDATED",
        summary: `Employee ${after.name} updated: ${Object.keys(changes).join(", ")}`,
        userName: req.user.name,
      });
    }
    return after;
  });
  res.json(emp);
}));

// ---- Payroll runs -------------------------------------------------------------
router.get("/runs", route(async (req, res) => {
  res.json(
    await req.db.payrollRun.findMany({
      orderBy: { payDate: "desc" },
      include: { paychecks: { include: { employee: { select: { id: true, name: true } } } } },
      take: 100,
    })
  );
}));

/** Pre-fill a new run: one paycheck per active employee with gross + FICA suggestions. */
router.post("/runs/preview", route(async (req, res) => {
  const { hours } = parse(
    z.object({
      hours: z.record(z.string(), z.object({ regular: z.coerce.number().min(0), overtime: z.coerce.number().min(0) })).default({}),
    }),
    req.body ?? {}
  );
  const employees = await req.db.employee.findMany({ where: { active: true }, orderBy: { name: "asc" } });
  res.json(
    employees.map((e) => {
      const h = hours[String(e.id)] ?? { regular: e.payType === "HOURLY" ? 80 : 0, overtime: 0 };
      const gross = grossPay({
        payType: e.payType,
        payRate: num(e.payRate),
        payFrequency: e.payFrequency,
        regularHours: h.regular,
        overtimeHours: h.overtime,
      });
      const fica = suggestedFica(gross);
      return {
        employeeId: e.id,
        name: e.name,
        payType: e.payType,
        payRate: num(e.payRate),
        regularHours: h.regular,
        overtimeHours: h.overtime,
        grossPay: gross,
        federalTax: 0,
        stateTax: 0,
        socialSecurity: fica.socialSecurity,
        medicare: fica.medicare,
        otherDeductions: 0,
        employerTaxes: round2(fica.socialSecurity + fica.medicare),
      };
    })
  );
}));

const runSchema = z.object({
  periodStart: z.coerce.date(),
  periodEnd: z.coerce.date(),
  payDate: z.coerce.date(),
  notes: z.string().trim().default(""),
  post: z.boolean().default(false),
  paychecks: z
    .array(
      z.object({
        employeeId: z.coerce.number().int().positive(),
        regularHours: z.coerce.number().min(0).default(0),
        overtimeHours: z.coerce.number().min(0).default(0),
        grossPay: z.coerce.number().min(0),
        federalTax: z.coerce.number().min(0).default(0),
        stateTax: z.coerce.number().min(0).default(0),
        socialSecurity: z.coerce.number().min(0).default(0),
        medicare: z.coerce.number().min(0).default(0),
        otherDeductions: z.coerce.number().min(0).default(0),
        employerTaxes: z.coerce.number().min(0).default(0),
      })
    )
    .min(1, "Add at least one employee"),
});

router.post("/runs", route(async (req, res) => {
  const input = parse(runSchema, req.body);
  const run = await req.db.$transaction(async (tx) => {
    const checks = input.paychecks.map((p) => {
      const net = netPay(p.grossPay, p);
      if (net < 0) throw badRequest("Deductions are more than gross pay for one employee");
      return { ...p, netPay: net };
    });
    const totalGross = round2(checks.reduce((s, c) => s + c.grossPay, 0));
    const totalNet = round2(checks.reduce((s, c) => s + c.netPay, 0));
    const totalEmployerTax = round2(checks.reduce((s, c) => s + c.employerTaxes, 0));
    const r = await tx.payrollRun.create({
      data: {
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        payDate: input.payDate,
        notes: input.notes,
        totalGross,
        totalNet,
        totalEmployerTax,
        paychecks: { create: checks },
      },
    });
    await logActivity(tx, {
      entityType: "Payroll",
      entityId: r.id,
      action: "CREATED",
      summary: `Payroll for ${input.periodStart.toISOString().slice(0, 10)} – ${input.periodEnd.toISOString().slice(0, 10)}: gross $${totalGross.toFixed(2)}, net $${totalNet.toFixed(2)}`,
      amount: totalGross,
      userName: req.user.name,
    });
    if (input.post) await postRun(tx, r.id, req.user.name);
    return r;
  });
  res.status(201).json(run);
}));

async function postRun(tx: Tx, id: number, userName: string) {
  const run = await tx.payrollRun.findUnique({ where: { id } });
  if (!run) throw notFound("Payroll run");
  if (run.status === "POSTED") throw badRequest("Already posted");
  await postEntry(tx, {
    date: run.payDate,
    memo: `Payroll paid ${run.payDate.toISOString().slice(0, 10)}`,
    sourceType: "PAYROLL",
    sourceRef: `RUN-${run.id}`,
    userName,
    lines: payrollEntry({ gross: num(run.totalGross), net: num(run.totalNet), employerTaxes: num(run.totalEmployerTax) }),
  });
  await tx.payrollRun.update({ where: { id }, data: { status: "POSTED" } });
  await logActivity(tx, {
    entityType: "Payroll",
    entityId: id,
    action: "POSTED",
    summary: `Payroll run #${id} posted to the books`,
    amount: num(run.totalGross),
    userName,
  });
}

router.post("/runs/:id/post", route(async (req, res) => {
  await req.db.$transaction((tx) => postRun(tx, idParam(req), req.user.name));
  res.json({ ok: true });
}));

router.delete("/runs/:id", route(async (req, res) => {
  const id = idParam(req);
  const run = await req.db.payrollRun.findUnique({ where: { id } });
  if (!run) throw notFound("Payroll run");
  if (run.status === "POSTED") throw badRequest("Posted payroll can't be deleted");
  await req.db.payrollRun.delete({ where: { id } });
  res.json({ ok: true });
}));

export default router;
