// Inventory / products: search, details (cost layers & movements), create,
// edit, stock adjustments, images, and bulk price-list import.
import { Router } from "express";
import fs from "fs";
import path from "path";
import multer from "multer";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { allow } from "../middleware/auth.js";
import { badRequest, idParam, notFound, parse, route, onlySent } from "../lib/http.js";
import { diffFields, logActivity } from "../lib/history.js";
import { num, round2 } from "../lib/money.js";
import { netCost, sellingPrice, marginPct } from "../domain/pricing.js";
import { weightedAverageCost, inventoryValue } from "../domain/costing.js";
import { decodeItemCode } from "../domain/itemCodes.js";
import { adjustStock, receiveStock } from "../services/inventory.js";
import { postEntry } from "../services/journal.js";
import { inventoryAdjustmentEntry } from "../domain/accounts.js";
import { getSettings } from "../services/settings.js";
import { availability } from "../services/availability.js";
import { orderBy, pageParams } from "./_shared.js";

const router = Router();

// ---- Image uploads --------------------------------------------------------
export const UPLOAD_DIR = path.join(process.cwd(), "uploads");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      const base = path.basename(file.originalname, ext).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40);
      cb(null, `${Date.now()}-${base}${ext}`);
    },
  }),
  fileFilter: (_req, file, cb) =>
    cb(null, ["image/png", "image/jpeg", "image/webp"].includes(file.mimetype)),
  limits: { fileSize: 5 * 1024 * 1024 },
});

const MAX_IMAGES = 12;

/**
 * A calendar day ("2026-10-09") becomes midday local time, so it never shows
 * as the day before/after in other time zones. Full date-times pass through.
 */
const dayAtNoon = (v: unknown) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T12:00:00` : v);
const dateInField = z.preprocess(dayAtNoon, z.coerce.date());

// ---- Validation -------------------------------------------------------------
const productSchema = z.object({
  itemCode: z.string().trim().min(1, "Item code is required").max(60).toUpperCase(),
  name: z.string().trim().min(1, "Name is required"),
  description: z.string().trim().default(""),
  categoryId: z.coerce.number().int().positive().optional().nullable(),
  supplierId: z.coerce.number().int().positive().optional().nullable(),
  collection: z.string().trim().default(""),
  unit: z.string().trim().default("unit"),
  listPrice: z.coerce.number().min(0).default(0),
  supplierDiscountPct: z.coerce.number().min(0).max(100).default(0),
  unitCost: z.coerce.number().min(0).optional(),
  sellPriceOverride: z.coerce.number().min(0).optional().nullable(),
  taxable: z.coerce.boolean().default(true),
  reorderPoint: z.coerce.number().min(0).default(0),
  reorderQty: z.coerce.number().min(0).default(0),
  /** Opening stock when creating a product. */
  openingQty: z.coerce.number().min(0).optional(),
  /** When the stock came in; or oldInventory = stock from before the POS system. */
  dateIn: dateInField.optional().nullable(),
  oldInventory: z.coerce.boolean().optional(),
});

/** ?dateIn=old → old inventory; dateInFrom / dateInTo → stock that came in between those days */
function dateInFilter(q: Record<string, unknown>): Prisma.ProductWhereInput {
  if (q.dateIn === "old") return { oldInventory: true };
  const from = q.dateInFrom ? new Date(String(q.dateInFrom)) : null;
  const to = q.dateInTo ? new Date(String(q.dateInTo) + "T23:59:59") : null;
  if (!from && !to) return {};
  return { oldInventory: false, dateIn: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } };
}

/** Multipart forms send everything as strings; turn "" into undefined. */
function cleanForm(body: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body ?? {})) {
    if (v === "" || v === undefined) continue;
    if (v === "null") {
      out[k] = null; // explicitly cleared (e.g. no fixed price, no category)
      continue;
    }
    out[k] = v === "true" ? true : v === "false" ? false : v;
  }
  return out;
}

// ---- List / search ------------------------------------------------------------
router.get(
  "/",
  route(async (req, res) => {
    const q = String(req.query.q || "").trim();
    const where: Prisma.ProductWhereInput = { deletedAt: null };
    if (q) {
      where.OR = [
        { itemCode: { contains: q, mode: "insensitive" } },
        { name: { contains: q, mode: "insensitive" } },
        { description: { contains: q, mode: "insensitive" } },
        { collection: { contains: q, mode: "insensitive" } },
      ];
    }
    if (req.query.categoryId) where.categoryId = Number(req.query.categoryId);
    if (req.query.supplierId) where.supplierId = Number(req.query.supplierId);
    if (req.query.collection) where.collection = String(req.query.collection);
    if (req.query.inStock === "true") where.qtyOnHand = { gt: 0 };
    Object.assign(where, dateInFilter(req.query));
    const { take, skip, page, limit } = pageParams(req, 50);
    const sort = orderBy(req, ["itemCode", "name", "qtyOnHand", "unitCost", "listPrice", "updatedAt", "dateIn"] as const, "itemCode", "asc");

    let lowStockIds: number[] | null = null;
    if (req.query.lowStock === "true") {
      const rows = await req.db.$queryRaw<{ id: number }[]>`
        SELECT id FROM "Product" WHERE "deletedAt" IS NULL AND "reorderPoint" > 0 AND "qtyOnHand" <= "reorderPoint"`;
      lowStockIds = rows.map((r) => r.id);
      where.id = { in: lowStockIds };
    }

    const include = {
      category: { select: { id: true, name: true } },
      supplier: { select: { id: true, name: true } },
    };
    const sortKey = String(req.query.sort || "");
    const dir = req.query.dir === "desc" ? "desc" : "asc";

    // Supplier and price are sorted here rather than by the database, so the
    // order is the same on every computer:
    //   supplier — A→Z by name, ignoring capitals / extra spaces; no supplier last
    //   price    — the item's fixed price, or its cost x the chosen level's markup
    // Work out every matching item's sort value, sort, then load just this page.
    if (sortKey === "supplier" || sortKey === "price") {
      const tier =
        sortKey === "price" ? await req.db.priceTier.findUnique({ where: { code: String(req.query.tier || "D") } }) : null;
      const markup = tier ? num(tier.markupPct) : 0;
      const all = await req.db.product.findMany({
        where,
        select: { id: true, itemCode: true, unitCost: true, sellPriceOverride: true, supplier: { select: { name: true } } },
      });
      const sign = dir === "asc" ? 1 : -1;
      const byCode = (a: { itemCode: string }, b: { itemCode: string }) =>
        a.itemCode.localeCompare(b.itemCode, "en", { numeric: true, sensitivity: "base" });
      const supplierOf = (p: (typeof all)[number]) => (p.supplier?.name ?? "").trim().replace(/\s+/g, " ");
      const priceOf = (p: (typeof all)[number]) =>
        sellingPrice(
          { unitCost: num(p.unitCost), sellPriceOverride: p.sellPriceOverride === null ? null : num(p.sellPriceOverride) },
          markup
        );
      const sorted =
        sortKey === "supplier"
          ? [...all].sort((a, b) => {
              const sa = supplierOf(a);
              const sb = supplierOf(b);
              if (!sa !== !sb) return sa ? -1 : 1; // no supplier always last
              return sign * sa.localeCompare(sb, "en", { numeric: true, sensitivity: "base" }) || byCode(a, b);
            })
          : [...all].sort((a, b) => sign * (priceOf(a) - priceOf(b)) || byCode(a, b));
      const ids = sorted.slice(skip, skip + take).map((p) => p.id);
      const rows = await req.db.product.findMany({ where: { id: { in: ids } }, include });
      const byId = new Map(rows.map((r) => [r.id, r]));
      return res.json({ items: ids.map((id) => byId.get(id)!), total: all.length, page, limit });
    }

    const orderByClause: Prisma.ProductOrderByWithRelationInput[] = [sort as Prisma.ProductOrderByWithRelationInput];

    const [items, total] = await Promise.all([
      req.db.product.findMany({ where, take, skip, orderBy: orderByClause, include }),
      req.db.product.count({ where }),
    ]);
    res.json({ items, total, page, limit });
  })
);

/** Products that need ordering (at or below reorder point), grouped by supplier. */
router.get(
  "/reorder",
  route(async (req, res) => {
    const rows = await req.db.$queryRaw<{ id: number }[]>`
      SELECT id FROM "Product" WHERE "deletedAt" IS NULL AND "reorderPoint" > 0 AND "qtyOnHand" <= "reorderPoint"`;
    const products = await req.db.product.findMany({
      where: { id: { in: rows.map((r) => r.id) } },
      include: { supplier: { select: { id: true, name: true } } },
      orderBy: { itemCode: "asc" },
    });
    res.json(
      products.map((p) => ({
        ...p,
        suggestedQty: Math.max(num(p.reorderQty), num(p.reorderPoint) - num(p.qtyOnHand) + 1),
      }))
    );
  })
);

/** On hand, promised on estimates/approvals, and available — for the sale screen. */
router.get(
  "/availability",
  route(async (req, res) => {
    const ids = String(req.query.ids || "")
      .split(",")
      .map(Number)
      .filter((x) => Number.isInteger(x) && x > 0)
      .slice(0, 200);
    const excludeEstimateId = req.query.excludeEstimate ? Number(req.query.excludeEstimate) : null;
    const map = await availability(req.db as never, ids, { excludeEstimateId });
    res.json([...map.values()]);
  })
);

router.get(
  "/collections",
  route(async (req, res) => {
    const rows = await req.db.product.groupBy({
      by: ["collection"],
      where: { deletedAt: null, collection: { not: "" } },
      _count: true,
      orderBy: { collection: "asc" },
    });
    res.json(rows.map((r) => ({ name: r.collection, count: r._count })));
  })
);

router.get(
  "/:id",
  route(async (req, res) => {
    const id = idParam(req);
    const product = await req.db.product.findUnique({
      where: { id },
      include: {
        category: true,
        supplier: true,
        lots: { where: { qtyRemaining: { gt: 0 } }, orderBy: { receivedAt: "asc" } },
        movements: { orderBy: { createdAt: "desc" }, take: 100 },
      },
    });
    if (!product) throw notFound("Product");
    const tiers = await req.db.priceTier.findMany({ orderBy: { sortOrder: "asc" } });
    const lots = product.lots.map((l) => ({
      id: l.id,
      receivedAt: l.receivedAt,
      qtyRemaining: num(l.qtyRemaining),
      unitCost: num(l.unitCost),
    }));
    const unitCost = num(product.unitCost);
    const override = product.sellPriceOverride === null ? null : num(product.sellPriceOverride);
    res.json({
      ...product,
      decoded: decodeItemCode(product.itemCode),
      weightedAverageCost: weightedAverageCost(lots),
      stockValue: inventoryValue(lots),
      prices: tiers.map((t) => {
        const price = sellingPrice({ unitCost, sellPriceOverride: override }, num(t.markupPct));
        return { tier: t.code, name: t.name, markupPct: num(t.markupPct), price, marginPct: marginPct(price, unitCost) };
      }),
    });
  })
);

// ---- Create / update ----------------------------------------------------------
router.post(
  "/",
  allow("MANAGER"),
  upload.array("images", 12),
  route(async (req, res) => {
    const input = parse(productSchema, cleanForm(req.body));
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    const settings = await getSettings(req.db);
    const unitCost = input.unitCost ?? netCost(input.listPrice, input.supplierDiscountPct);
    const { openingQty, ...data } = input;
    const product = await req.db.$transaction(async (tx) => {
      const p = await tx.product.create({
        data: { ...data, unitCost, images: files.map((f) => f.filename) },
      });
      await logActivity(tx, {
        entityType: "Product",
        entityId: p.id,
        entityRef: p.itemCode,
        action: "CREATED",
        summary: `Product ${p.itemCode} — ${p.name} added (cost $${num(p.unitCost).toFixed(2)})`,
        userName: req.user.name,
      });
      if (openingQty && openingQty > 0) {
        await adjustStock(tx, {
          productId: p.id,
          qtyChange: openingQty,
          unitCost,
          dateIn: data.dateIn ?? undefined,
          oldInventory: data.oldInventory,
          reason: data.oldInventory ? "Old inventory (before POS system)" : "Opening stock",
          method: settings.costingMethod,
          userName: req.user.name,
        });
      }
      return p;
    });
    res.status(201).json(product);
  })
);

router.put(
  "/:id",
  allow("MANAGER"),
  upload.array("images", 12),
  route(async (req, res) => {
    const id = idParam(req);
    const form = cleanForm(req.body);
    const input = onlySent(parse(productSchema.partial(), form), form);
    delete input.openingQty;
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    const removeImages = String(req.body.removeImages || "").split(",").filter(Boolean);
    const product = await req.db.$transaction(async (tx) => {
      const before = await tx.product.findUnique({ where: { id } });
      if (!before) throw notFound("Product");
      const images = [...before.images.filter((i) => !removeImages.includes(i)), ...files.map((f) => f.filename)];
      if (images.length > MAX_IMAGES) throw badRequest(`An item can have up to ${MAX_IMAGES} photos. Remove some first.`);
      // If list price or discount changed but cost wasn't typed, recompute cost.
      const data: Prisma.ProductUpdateInput = { ...input, images };
      if (input.unitCost === undefined && (input.listPrice !== undefined || input.supplierDiscountPct !== undefined)) {
        data.unitCost = netCost(
          input.listPrice ?? num(before.listPrice),
          input.supplierDiscountPct ?? num(before.supplierDiscountPct)
        );
      }
      if (input.categoryId !== undefined) {
        delete (data as Record<string, unknown>).categoryId;
        data.category = input.categoryId ? { connect: { id: input.categoryId } } : { disconnect: true };
      }
      if (input.supplierId !== undefined) {
        delete (data as Record<string, unknown>).supplierId;
        data.supplier = input.supplierId ? { connect: { id: input.supplierId } } : { disconnect: true };
      }
      const after = await tx.product.update({ where: { id }, data });
      const changes = diffFields(before as never, after as never);
      if (Object.keys(changes).length) {
        await logActivity(tx, {
          entityType: "Product",
          entityId: id,
          entityRef: after.itemCode,
          action: "UPDATED",
          summary: `Product ${after.itemCode} updated: ${Object.keys(changes).join(", ")}`,
          details: JSON.parse(JSON.stringify(changes)),
          userName: req.user.name,
        });
      }
      return after;
    });
    res.json(product);
  })
);

router.delete(
  "/:id",
  allow("MANAGER"),
  route(async (req, res) => {
    const id = idParam(req);
    await req.db.$transaction(async (tx) => {
      const p = await tx.product.update({ where: { id }, data: { deletedAt: new Date() } });
      await tx.archive.create({ data: { entity: "Product", entityId: id, data: JSON.parse(JSON.stringify(p)) } });
      await logActivity(tx, {
        entityType: "Product",
        entityId: id,
        entityRef: p.itemCode,
        action: "ARCHIVED",
        summary: `Product ${p.itemCode} archived`,
        userName: req.user.name,
      });
    });
    res.json({ ok: true });
  })
);

// ---- Stock -------------------------------------------------------------------
const adjustSchema = z.object({
  qtyChange: z.coerce.number().refine((n) => n !== 0, "Quantity change cannot be zero"),
  unitCost: z.coerce.number().min(0).optional(),
  costUpdate: z.enum(["average", "replace", "keep"]).default("average"),
  reason: z.string().trim().min(1, "Give a reason (count, damage, opening stock...)"),
  /** For added units: when they came in, or old inventory from before the POS. */
  dateIn: dateInField.optional(),
  oldInventory: z.boolean().optional(),
});

router.post(
  "/:id/adjust",
  allow("MANAGER"),
  route(async (req, res) => {
    const id = idParam(req);
    const input = parse(adjustSchema, req.body);
    const settings = await getSettings(req.db);
    const result = await req.db.$transaction((tx) =>
      adjustStock(tx, { productId: id, ...input, method: settings.costingMethod, userName: req.user.name })
    );
    res.json(result);
  })
);

// ---- Bulk import (price list) ------------------------------------------------------
const importRow = z.object({
  itemCode: z.string().trim().min(1).max(60).toUpperCase(),
  name: z.string().trim().min(1),
  description: z.string().trim().default(""),
  category: z.string().trim().default(""),
  collection: z.string().trim().default(""),
  supplier: z.string().trim().default(""),
  listPrice: z.coerce.number().min(0).default(0),
  supplierDiscountPct: z.coerce.number().min(0).max(100).default(0),
  unitCost: z.coerce.number().min(0).optional(),
  unit: z.string().trim().default("unit"),
  qtyOnHand: z.coerce.number().min(0).optional(),
  /** "old" (or empty) = old inventory from before the POS; or a date like 2026-10-09 */
  dateIn: z
    .string()
    .trim()
    .default("")
    .refine((v) => !v || /^(old|before|pre)/i.test(v) || !Number.isNaN(new Date(v).getTime()), {
      message: 'dateIn must be a date (e.g. 2026-10-09) or "old"',
    }),
});

/** Import rows: blank / "old" → old inventory; anything else is the date it came in. */
function importDateIn(v: string): { dateIn: Date | null; oldInventory: boolean } {
  if (!v || /^(old|before|pre)/i.test(v)) return { dateIn: null, oldInventory: true };
  return { dateIn: new Date(String(dayAtNoon(v))), oldInventory: false };
}

router.post(
  "/import",
  allow("MANAGER"),
  route(async (req, res) => {
    const rows = parse(z.array(importRow).max(10000), req.body?.rows);
    if (rows.length === 0) throw badRequest("No rows to import");
    const settings = await getSettings(req.db);
    let created = 0;
    let updated = 0;
    let openingValue = 0;
    // Look up / create categories and suppliers once
    const categories = new Map((await req.db.category.findMany()).map((c) => [c.name.toLowerCase(), c.id]));
    const suppliers = new Map((await req.db.supplier.findMany()).map((s) => [s.name.toLowerCase(), s.id]));
    for (const r of rows) {
      if (r.category && !categories.has(r.category.toLowerCase())) {
        const c = await req.db.category.create({ data: { name: r.category, sortOrder: categories.size + 1 } });
        categories.set(c.name.toLowerCase(), c.id);
      }
      if (r.supplier && !suppliers.has(r.supplier.toLowerCase())) {
        const s = await req.db.supplier.create({ data: { name: r.supplier } });
        suppliers.set(s.name.toLowerCase(), s.id);
      }
    }
    // Chunked so a big price list doesn't hold one giant transaction
    for (let i = 0; i < rows.length; i += 200) {
      const chunk = rows.slice(i, i + 200);
      await req.db.$transaction(async (tx) => {
        for (const r of chunk) {
          const unitCost = r.unitCost ?? netCost(r.listPrice, r.supplierDiscountPct);
          const data = {
            name: r.name,
            description: r.description,
            collection: r.collection,
            unit: r.unit,
            listPrice: r.listPrice,
            supplierDiscountPct: r.supplierDiscountPct,
            unitCost,
            categoryId: r.category ? categories.get(r.category.toLowerCase()) ?? null : null,
            supplierId: r.supplier ? suppliers.get(r.supplier.toLowerCase()) ?? null : null,
          };
          const existing = await tx.product.findUnique({ where: { itemCode: r.itemCode } });
          if (existing) {
            await tx.product.update({ where: { id: existing.id }, data: { ...data, deletedAt: null } });
            updated++;
          } else {
            const when = importDateIn(r.dateIn);
            const p = await tx.product.create({ data: { itemCode: r.itemCode, ...data, ...when } });
            created++;
            if (r.qtyOnHand && r.qtyOnHand > 0) {
              openingValue = round2(openingValue + r.qtyOnHand * unitCost);
              await receiveStock(tx, {
                productId: p.id,
                qty: r.qtyOnHand,
                unitCost,
                source: "OPENING",
                sourceRef: "IMPORT",
                date: when.dateIn ?? undefined,
                oldInventory: when.oldInventory,
              });
            }
          }
        }
      }, { timeout: 120000 });
    }
    // Opening stock from an import goes to the books in one entry
    await req.db.$transaction(async (tx) => {
      if (openingValue > 0) {
        await postEntry(tx, {
          memo: "Opening stock from import",
          sourceType: "INVENTORY_ADJUSTMENT",
          sourceRef: "IMPORT",
          userName: req.user.name,
          lines: inventoryAdjustmentEntry(openingValue),
        });
      }
      await logActivity(tx, {
        entityType: "Product",
        action: "IMPORTED",
        summary: `Imported price list: ${created} new, ${updated} updated (${settings.name})`,
        amount: openingValue || null,
        userName: req.user.name,
      });
    });
    res.json({ created, updated });
  })
);

export default router;
