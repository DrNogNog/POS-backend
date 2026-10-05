// Store settings, tax rates, price tiers, chart of accounts, categories.
import { Router } from "express";
import { z } from "zod";
import { allow } from "../middleware/auth.js";
import { idParam, parse, route } from "../lib/http.js";
import { diffFields, logActivity } from "../lib/history.js";
import { getSettings } from "../services/settings.js";
import { decodeItemCode, CODE_TYPES, COLLECTIONS } from "../domain/itemCodes.js";

const router = Router();

router.get(
  "/",
  route(async (req, res) => {
    const [settings, taxRates, priceTiers, accounts, categories] = await Promise.all([
      getSettings(req.db),
      req.db.taxRate.findMany({ orderBy: { name: "asc" } }),
      req.db.priceTier.findMany({ orderBy: { sortOrder: "asc" } }),
      req.db.account.findMany({ orderBy: { code: "asc" } }),
      req.db.category.findMany({ orderBy: { sortOrder: "asc" } }),
    ]);
    res.json({ settings, taxRates, priceTiers, accounts, categories, storeId: req.storeId });
  })
);

const settingsSchema = z.object({
  name: z.string().trim().min(1),
  address: z.string().trim(),
  city: z.string().trim(),
  state: z.string().trim(),
  zip: z.string().trim(),
  phone: z.string().trim(),
  fax: z.string().trim(),
  email: z.string().trim(),
  website: z.string().trim(),
  costingMethod: z.enum(["FIFO", "LIFO", "WAC"]),
  defaultCustomerTermsDays: z.coerce.number().int().min(0).max(365),
  earlyPayDiscountPct: z.coerce.number().min(0).max(100),
  earlyPayDiscountDays: z.coerce.number().int().min(0).max(365),
  lateFeePct: z.coerce.number().min(0).max(100),
  lateFeeFlat: z.coerce.number().min(0),
  collectionsAfterDays: z.coerce.number().int().min(1),
  arHighDso: z.coerce.number().int().min(1),
  arLowDso: z.coerce.number().int().min(0),
  invoicePrefix: z.string().trim().min(1).max(10),
  estimatePrefix: z.string().trim().min(1).max(10),
  poPrefix: z.string().trim().min(1).max(10),
}).partial();

router.put(
  "/",
  allow("MANAGER"),
  route(async (req, res) => {
    const input = parse(settingsSchema, req.body);
    const result = await req.db.$transaction(async (tx) => {
      const before = await getSettings(tx);
      const after = await tx.storeSettings.update({ where: { id: 1 }, data: input });
      const changes = diffFields(before as never, after as never);
      if (Object.keys(changes).length) {
        await logActivity(tx, {
          entityType: "Settings",
          entityId: 1,
          action: "UPDATED",
          summary: `Store settings changed: ${Object.keys(changes).join(", ")}`,
          details: JSON.parse(JSON.stringify(changes)),
          userName: req.user.name,
        });
      }
      return after;
    });
    res.json(result);
  })
);

// ---- Price tiers ------------------------------------------------------------
const tierSchema = z.array(
  z.object({
    code: z.string().trim().min(1).max(4).toUpperCase(),
    name: z.string().trim().min(1),
    markupPct: z.coerce.number().min(0).max(1000),
    sortOrder: z.coerce.number().int().default(0),
    description: z.string().trim().default(""),
  })
);

router.put(
  "/price-tiers",
  allow("MANAGER"),
  route(async (req, res) => {
    const tiers = parse(tierSchema, req.body);
    await req.db.$transaction(async (tx) => {
      for (const t of tiers) {
        await tx.priceTier.upsert({ where: { code: t.code }, create: t, update: t });
      }
      await logActivity(tx, {
        entityType: "Settings",
        action: "PRICE_TIERS",
        summary: `Price tiers updated: ${tiers.map((t) => `${t.code} ${t.markupPct}%`).join(", ")}`,
        userName: req.user.name,
      });
    });
    res.json(await req.db.priceTier.findMany({ orderBy: { sortOrder: "asc" } }));
  })
);

// ---- Tax rates (each store has its own) ------------------------------------
const taxSchema = z.object({
  name: z.string().trim().min(1),
  ratePct: z.coerce.number().min(0).max(30),
  isDefault: z.boolean().default(false),
  active: z.boolean().default(true),
});

async function saveTax(req: Parameters<Parameters<typeof route>[0]>[0], id?: number) {
  const input = parse(taxSchema, req.body);
  return req.db.$transaction(async (tx) => {
    if (input.isDefault) await tx.taxRate.updateMany({ data: { isDefault: false } });
    const rate = id
      ? await tx.taxRate.update({ where: { id }, data: input })
      : await tx.taxRate.create({ data: input });
    await logActivity(tx, {
      entityType: "Settings",
      entityId: rate.id,
      action: id ? "TAX_UPDATED" : "TAX_CREATED",
      summary: `Tax rate "${rate.name}" ${input.ratePct}%${input.isDefault ? " (default)" : ""}`,
      userName: req.user.name,
    });
    return rate;
  });
}

router.post("/tax-rates", allow("MANAGER", "ACCOUNTANT"), route(async (req, res) => {
  res.status(201).json(await saveTax(req));
}));
router.put("/tax-rates/:id", allow("MANAGER", "ACCOUNTANT"), route(async (req, res) => {
  res.json(await saveTax(req, idParam(req)));
}));

// ---- Categories ---------------------------------------------------------------
router.post(
  "/categories",
  allow("MANAGER"),
  route(async (req, res) => {
    const { name } = parse(z.object({ name: z.string().trim().min(1) }), req.body);
    const count = await req.db.category.count();
    res.status(201).json(await req.db.category.create({ data: { name, sortOrder: count + 1 } }));
  })
);

// ---- Item codes ---------------------------------------------------------------
router.get("/item-codes", (_req, res) => {
  res.json({ types: CODE_TYPES, collections: COLLECTIONS });
});
router.get("/item-codes/:code", (req, res) => {
  res.json(decodeItemCode(String(req.params.code)));
});

export default router;
