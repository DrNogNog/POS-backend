// -----------------------------------------------------------------------------
// Reports built from the journal (the books) and open documents.
//   - Trial balance, Balance sheet, Income statement (P&L)
//   - A/R board (aging, DSO, health) and A/P board (aging, due soon, discounts)
// -----------------------------------------------------------------------------
import type { AccountType } from "@prisma/client";
import type { Tx } from "../db/stores.js";
import { num, round2 } from "../lib/money.js";
import { addDays, daysBetween } from "../lib/dates.js";
import { agingBucket, agingSummary } from "../domain/terms.js";
import { receivablesHealth } from "../domain/receivablesHealth.js";
import { presentInvoice } from "./sales.js";
import { presentBill } from "./purchasing.js";
import { getSettings } from "./settings.js";

const DEBIT_NORMAL: AccountType[] = ["ASSET", "EXPENSE", "COGS", "CONTRA_REVENUE"];

/** Balance of every account between two dates (inclusive). */
export async function accountBalances(tx: Tx, opts: { from?: Date; to?: Date } = {}) {
  const accounts = await tx.account.findMany({ orderBy: { code: "asc" } });
  const sums = await tx.journalLine.groupBy({
    by: ["accountCode"],
    _sum: { debit: true, credit: true },
    where: {
      entry: {
        date: {
          ...(opts.from ? { gte: opts.from } : {}),
          ...(opts.to ? { lte: opts.to } : {}),
        },
      },
    },
  });
  const byCode = new Map(sums.map((s) => [s.accountCode, s._sum]));
  return accounts.map((a) => {
    const s = byCode.get(a.code);
    const debit = num(s?.debit);
    const credit = num(s?.credit);
    const balance = DEBIT_NORMAL.includes(a.type) ? round2(debit - credit) : round2(credit - debit);
    return { code: a.code, name: a.name, type: a.type, isCurrent: a.isCurrent, debit, credit, balance };
  });
}

export async function trialBalance(tx: Tx, to?: Date) {
  const rows = await accountBalances(tx, { to });
  const totalDebit = round2(rows.reduce((s, r) => s + r.debit, 0));
  const totalCredit = round2(rows.reduce((s, r) => s + r.credit, 0));
  return { rows, totalDebit, totalCredit, inBalance: Math.abs(totalDebit - totalCredit) < 0.005 };
}

export async function incomeStatement(tx: Tx, from: Date, to: Date) {
  const rows = (await accountBalances(tx, { from, to })).filter((r) =>
    ["REVENUE", "CONTRA_REVENUE", "COGS", "EXPENSE"].includes(r.type)
  );
  const pick = (t: AccountType) => rows.filter((r) => r.type === t);
  const revenue = round2(pick("REVENUE").reduce((s, r) => s + r.balance, 0));
  const contra = round2(pick("CONTRA_REVENUE").reduce((s, r) => s + r.balance, 0));
  const netRevenue = round2(revenue - contra);
  const cogs = round2(pick("COGS").reduce((s, r) => s + r.balance, 0));
  const grossProfit = round2(netRevenue - cogs);
  const expenses = round2(pick("EXPENSE").reduce((s, r) => s + r.balance, 0));
  return {
    from,
    to,
    revenue: pick("REVENUE"),
    contraRevenue: pick("CONTRA_REVENUE"),
    cogs: pick("COGS"),
    expenses: pick("EXPENSE"),
    totals: {
      revenue,
      discounts: contra,
      netRevenue,
      cogs,
      grossProfit,
      grossMarginPct: netRevenue > 0 ? round2((grossProfit / netRevenue) * 100) : 0,
      expenses,
      netIncome: round2(grossProfit - expenses),
    },
  };
}

export async function balanceSheet(tx: Tx, asOf = new Date()) {
  const rows = await accountBalances(tx, { to: asOf });
  const assets = rows.filter((r) => r.type === "ASSET");
  const liabilities = rows.filter((r) => r.type === "LIABILITY");
  const equity = rows.filter((r) => r.type === "EQUITY");
  // Profit to date that hasn't been closed into equity yet
  const income = rows.filter((r) => ["REVENUE", "CONTRA_REVENUE", "COGS", "EXPENSE"].includes(r.type));
  const netIncome = round2(
    income.reduce((s, r) => s + (r.type === "REVENUE" ? r.balance : -r.balance), 0)
  );
  const total = (list: typeof rows) => round2(list.reduce((s, r) => s + r.balance, 0));
  const currentAssets = total(assets.filter((a) => a.isCurrent));
  const currentLiabilities = total(liabilities.filter((a) => a.isCurrent));
  const totalEquity = round2(total(equity) + netIncome);
  return {
    asOf,
    assets,
    liabilities,
    equity,
    netIncome,
    totals: {
      assets: total(assets),
      currentAssets,
      liabilities: total(liabilities),
      currentLiabilities,
      equity: totalEquity,
      liabilitiesAndEquity: round2(total(liabilities) + totalEquity),
      workingCapital: round2(currentAssets - currentLiabilities),
      currentRatio: currentLiabilities > 0 ? round2(currentAssets / currentLiabilities) : null,
    },
  };
}

// ---- A/R board -------------------------------------------------------------

export async function receivablesBoard(tx: Tx, today = new Date()) {
  const settings = await getSettings(tx);
  const open = await tx.invoice.findMany({
    where: { status: { in: ["OPEN", "PARTIAL"] } },
    include: { customer: { select: { id: true, name: true, phone: true } } },
    orderBy: { dueDate: "asc" },
  });
  const items = open.map((i) => presentInvoice(i, today));
  const aging = agingSummary(items.map((i) => ({ dueDate: i.dueDate, balance: i.balance })), today);

  const periodDays = 90;
  const since = addDays(today, -periodDays);
  const recent = await tx.invoice.findMany({
    where: { issueDate: { gte: since }, status: { not: "VOID" } },
    select: { total: true, termsDays: true },
  });
  const salesInPeriod = round2(recent.reduce((s, r) => s + num(r.total), 0));
  const creditSalesInPeriod = round2(
    recent.filter((r) => r.termsDays > 0).reduce((s, r) => s + num(r.total), 0)
  );
  const overdueBalance = round2(items.filter((i) => i.isOverdue).reduce((s, i) => s + i.balance, 0));
  const health = receivablesHealth({
    arBalance: aging.total,
    overdueBalance,
    salesInPeriod,
    creditSalesInPeriod,
    periodDays,
    highDso: settings.arHighDso,
    lowDso: settings.arLowDso,
  });

  // Balance by customer (top 10)
  const byCustomer = new Map<string, { customerId: number | null; name: string; balance: number; overdue: number }>();
  for (const i of items) {
    const key = i.customer ? String(i.customer.id) : `walkin:${i.billTo.split("\n")[0]}`;
    const row = byCustomer.get(key) ?? {
      customerId: i.customer?.id ?? null,
      name: i.customer?.name ?? (i.billTo.split("\n")[0] || "Walk-in"),
      balance: 0,
      overdue: 0,
    };
    row.balance = round2(row.balance + i.balance);
    if (i.isOverdue) row.overdue = round2(row.overdue + i.balance);
    byCustomer.set(key, row);
  }

  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
  const collected = await tx.customerPayment.aggregate({
    _sum: { amount: true, discountTaken: true },
    where: { date: { gte: monthStart } },
  });

  return {
    aging,
    health,
    salesInPeriod,
    periodDays,
    collectedThisMonth: num(collected._sum.amount),
    discountsGivenThisMonth: num(collected._sum.discountTaken),
    needsCollections: items.filter((i) => i.daysPastDue >= settings.collectionsAfterDays && i.collectionStatus !== "COLLECTIONS").length,
    topCustomers: [...byCustomer.values()].sort((a, b) => b.balance - a.balance).slice(0, 10),
    invoices: items.map((i) => ({ ...i, bucket: agingBucket(i.dueDate, today) })),
  };
}

// ---- A/P board -------------------------------------------------------------

export async function payablesBoard(tx: Tx, today = new Date()) {
  const open = await tx.supplierBill.findMany({
    where: { status: { in: ["OPEN", "PARTIAL"] } },
    include: { supplier: { select: { id: true, name: true } } },
    orderBy: { dueDate: "asc" },
  });
  const items = open.map((b) => presentBill(b, today));
  const aging = agingSummary(items.map((i) => ({ dueDate: i.dueDate, balance: i.balance })), today);
  const dueIn7 = round2(
    items
      .filter((i) => {
        const d = daysBetween(today, i.dueDate);
        return d >= 0 && d <= 7;
      })
      .reduce((s, i) => s + i.balance, 0)
  );
  const discountsAvailable = items
    .filter((i) => i.earlyDiscountAvailableNow)
    .map((i) => ({
      billId: i.id,
      billNo: i.billNo,
      supplier: i.supplier.name,
      save: i.earlyDiscountAmount,
      payBy: i.earlyDiscountDeadline,
      payAmount: round2(i.balance - i.earlyDiscountAmount),
    }));

  const bySupplier = new Map<number, { supplierId: number; name: string; balance: number; overdue: number }>();
  for (const i of items) {
    const row = bySupplier.get(i.supplier.id) ?? { supplierId: i.supplier.id, name: i.supplier.name, balance: 0, overdue: 0 };
    row.balance = round2(row.balance + i.balance);
    if (i.isOverdue) row.overdue = round2(row.overdue + i.balance);
    bySupplier.set(i.supplier.id, row);
  }

  // Days Payable Outstanding: A/P / purchases in last 90 days x 90
  const since = addDays(today, -90);
  const purchases = await tx.supplierBill.aggregate({
    _sum: { total: true },
    where: { billDate: { gte: since }, status: { not: "VOID" } },
  });
  const purchased = num(purchases._sum.total);
  const dpo = purchased > 0 ? round2((aging.total / purchased) * 90) : 0;

  const bs = await balanceSheet(tx, today);
  return {
    aging,
    dueIn7,
    dpo,
    discountsAvailable,
    bySupplier: [...bySupplier.values()].sort((a, b) => b.balance - a.balance),
    currentLiabilities: bs.liabilities,
    currentLiabilitiesTotal: bs.totals.currentLiabilities,
    currentAssetsTotal: bs.totals.currentAssets,
    currentRatio: bs.totals.currentRatio,
    bills: items.map((i) => ({ ...i, bucket: agingBucket(i.dueDate, today) })),
  };
}

// ---- Dashboard ---------------------------------------------------------------

export async function dashboard(tx: Tx, today = new Date()) {
  const dayStart = new Date(today);
  dayStart.setHours(0, 0, 0, 0);
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
  const [salesToday, salesMonth, ar, ap, lowStock, pendingEstimates, recent] = await Promise.all([
    tx.invoice.aggregate({ _sum: { total: true, taxAmount: true }, _count: true, where: { issueDate: { gte: dayStart }, status: { not: "VOID" } } }),
    tx.invoice.aggregate({ _sum: { total: true, cogsTotal: true, taxAmount: true }, where: { issueDate: { gte: monthStart }, status: { not: "VOID" } } }),
    receivablesBoard(tx, today),
    payablesBoard(tx, today),
    tx.$queryRaw<{ id: number; itemCode: string; name: string; qtyOnHand: unknown; reorderPoint: unknown }[]>`
      SELECT id, "itemCode", name, "qtyOnHand", "reorderPoint" FROM "Product"
      WHERE "deletedAt" IS NULL AND "reorderPoint" > 0 AND "qtyOnHand" <= "reorderPoint"
      ORDER BY "qtyOnHand" ASC LIMIT 20`,
    tx.estimate.count({ where: { status: "PENDING" } }),
    tx.activityLog.findMany({ orderBy: { createdAt: "desc" }, take: 12 }),
  ]);
  const inv = await tx.inventoryLot.findMany({ where: { qtyRemaining: { gt: 0 } }, select: { qtyRemaining: true, unitCost: true } });
  const inventoryValue = round2(inv.reduce((s, l) => s + num(l.qtyRemaining) * num(l.unitCost), 0));
  const monthSales = num(salesMonth._sum.total) - num(salesMonth._sum.taxAmount);
  const monthCogs = num(salesMonth._sum.cogsTotal);
  return {
    salesToday: round2(num(salesToday._sum.total) - num(salesToday._sum.taxAmount)),
    invoicesToday: salesToday._count,
    salesMonth: round2(monthSales),
    grossProfitMonth: round2(monthSales - monthCogs),
    grossMarginMonthPct: monthSales > 0 ? round2(((monthSales - monthCogs) / monthSales) * 100) : 0,
    arTotal: ar.aging.total,
    arOverdue: round2(ar.aging.total - ar.aging.current),
    arHealth: ar.health,
    apTotal: ap.aging.total,
    apDueIn7: ap.dueIn7,
    apDiscountsAvailable: ap.discountsAvailable.length,
    inventoryValue,
    lowStock: lowStock.map((p) => ({ ...p, qtyOnHand: num(p.qtyOnHand), reorderPoint: num(p.reorderPoint) })),
    pendingEstimates,
    recent,
  };
}
