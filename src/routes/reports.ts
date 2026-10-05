// Dashboard, financial statements, journal, history and archives.
import { Router } from "express";
import type { Prisma } from "@prisma/client";
import { allow, BOOKKEEPERS } from "../middleware/auth.js";
import { route } from "../lib/http.js";
import { balanceSheet, dashboard, incomeStatement, trialBalance } from "../services/reports.js";
import { pageParams } from "./_shared.js";

// ---- Reports (/api/reports) -------------------------------------------------
export const reportsRouter = Router();

reportsRouter.get("/dashboard", route(async (req, res) => {
  res.json(await dashboard(req.db));
}));

function range(q: Record<string, unknown>) {
  const now = new Date();
  const from = q.from ? new Date(String(q.from)) : new Date(now.getFullYear(), 0, 1);
  const to = q.to ? new Date(String(q.to) + "T23:59:59") : now;
  return { from, to };
}

reportsRouter.get("/income-statement", allow(...BOOKKEEPERS), route(async (req, res) => {
  const { from, to } = range(req.query);
  res.json(await incomeStatement(req.db, from, to));
}));

reportsRouter.get("/balance-sheet", allow(...BOOKKEEPERS), route(async (req, res) => {
  const { to } = range(req.query);
  res.json(await balanceSheet(req.db, to));
}));

reportsRouter.get("/trial-balance", allow(...BOOKKEEPERS), route(async (req, res) => {
  const { to } = range(req.query);
  res.json(await trialBalance(req.db, to));
}));

reportsRouter.get("/journal", allow(...BOOKKEEPERS), route(async (req, res) => {
  const { from, to } = range(req.query);
  const { take, skip } = pageParams(req, 100);
  const where: Prisma.JournalEntryWhereInput = { date: { gte: from, lte: to } };
  if (req.query.account) where.lines = { some: { accountCode: String(req.query.account) } };
  const [items, total] = await Promise.all([
    req.db.journalEntry.findMany({
      where,
      orderBy: { date: "desc" },
      include: { lines: { include: { account: { select: { name: true } } } } },
      take,
      skip,
    }),
    req.db.journalEntry.count({ where }),
  ]);
  res.json({ items, total });
}));

// ---- History tab (/api/history) -----------------------------------------------
export const historyRouter = Router();

historyRouter.get("/", route(async (req, res) => {
  const where: Prisma.ActivityLogWhereInput = {};
  if (req.query.entityType) where.entityType = String(req.query.entityType);
  if (req.query.entityId) where.entityId = Number(req.query.entityId);
  if (req.query.action) where.action = String(req.query.action);
  const q = String(req.query.q || "").trim();
  if (q) {
    where.OR = [
      { summary: { contains: q, mode: "insensitive" } },
      { entityRef: { contains: q, mode: "insensitive" } },
      { userName: { contains: q, mode: "insensitive" } },
    ];
  }
  if (req.query.from || req.query.to) {
    where.createdAt = {
      ...(req.query.from ? { gte: new Date(String(req.query.from)) } : {}),
      ...(req.query.to ? { lte: new Date(String(req.query.to) + "T23:59:59") } : {}),
    };
  }
  const { take, skip, page, limit } = pageParams(req, 100);
  const [items, total, types] = await Promise.all([
    req.db.activityLog.findMany({
      where,
      orderBy: { createdAt: req.query.dir === "asc" ? "asc" : "desc" },
      take,
      skip,
    }),
    req.db.activityLog.count({ where }),
    req.db.activityLog.groupBy({ by: ["entityType"], _count: true }),
  ]);
  res.json({ items, total, page, limit, types: types.map((t) => t.entityType).sort() });
}));

// ---- Archives (/api/archives) ---------------------------------------------------
export const archivesRouter = Router();
archivesRouter.get("/", route(async (req, res) => {
  res.json(await req.db.archive.findMany({ orderBy: { createdAt: "desc" }, take: 500 }));
}));
