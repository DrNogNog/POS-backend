// Shared bits for route files: input validators and small response helpers.
import type { Request, Response } from "express";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { renderDocumentPdf, type PdfDocumentData } from "../pdf/documentPdf.js";
import { getSettings } from "../services/settings.js";

export const money = z.coerce.number().finite().min(0);
export const qty = z.coerce.number().finite().positive();
export const optionalInt = z.coerce.number().int().optional().nullable();
export const optionalDate = z.coerce.date().optional().nullable();
export const text = z.string().trim().max(5000).default("");
export const paymentMethod = z.enum(["CASH", "CREDIT", "DEBIT", "CHECK", "OTHER"]);
export const fulfillment = z.enum(["PICKUP", "DELIVERY"]);

export const lineSchema = z.object({
  productId: z.coerce.number().int().positive().optional().nullable(),
  itemCode: z.string().trim().max(100).optional(),
  description: z.string().trim().max(1000).optional(),
  qty,
  unitPrice: money,
});

/** Sorting helper: ?sort=issueDate&dir=asc limited to allowed fields. */
export function orderBy<T extends string>(
  req: Request,
  allowed: readonly T[],
  fallback: T,
  fallbackDir: "asc" | "desc" = "desc"
): Record<string, "asc" | "desc"> {
  const sort = String(req.query.sort || fallback) as T;
  const dir = req.query.dir === "asc" ? "asc" : req.query.dir === "desc" ? "desc" : fallbackDir;
  return { [allowed.includes(sort) ? sort : fallback]: dir };
}

export function pageParams(req: Request, defaultLimit = 50) {
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || defaultLimit));
  const page = Math.max(1, Number(req.query.page) || 1);
  return { take: limit, skip: (page - 1) * limit, page, limit };
}

export async function sendPdf(
  req: Request,
  res: Response,
  filename: string,
  data: PdfDocumentData
) {
  const settings = await getSettings(req.db);
  const bytes = await renderDocumentPdf(settings, data);
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${filename}.pdf"`);
  res.send(Buffer.from(bytes));
}

export type Json = Prisma.InputJsonValue;
