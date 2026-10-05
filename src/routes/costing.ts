// Costing screen: compare FIFO, LIFO and Weighted Average for each product
// using its real purchase and sales history, plus current weighted averages.
import { Router } from "express";
import { route } from "../lib/http.js";
import { num, round2 } from "../lib/money.js";
import { simulate, weightedAverageCost, inventoryValue, type CostEvent } from "../domain/costing.js";
import { marginPct, sellingPrice } from "../domain/pricing.js";
import { getSettings } from "../services/settings.js";

const router = Router();

router.get(
  "/",
  route(async (req, res) => {
    const settings = await getSettings(req.db);
    const productId = req.query.productId ? Number(req.query.productId) : undefined;
    const to = req.query.to ? new Date(String(req.query.to) + "T23:59:59") : undefined;

    const movements = await req.db.inventoryMovement.findMany({
      where: {
        ...(productId ? { productId } : {}),
        ...(to ? { createdAt: { lte: to } } : {}),
      },
      orderBy: { createdAt: "asc" },
    });
    const productIds = [...new Set(movements.map((m) => m.productId))];
    const [products, saleLines, lots, tiers] = await Promise.all([
      req.db.product.findMany({
        where: { id: { in: productIds } },
        include: { category: { select: { name: true } }, supplier: { select: { name: true } } },
      }),
      req.db.invoiceLine.findMany({
        where: { productId: { in: productIds }, invoice: { status: { not: "VOID" } } },
        select: { productId: true, unitPrice: true, invoice: { select: { invoiceNo: true } } },
      }),
      req.db.inventoryLot.findMany({ where: { productId: { in: productIds }, qtyRemaining: { gt: 0 } } }),
      req.db.priceTier.findMany({ orderBy: { sortOrder: "asc" } }),
    ]);
    const priceOf = new Map(saleLines.map((l) => [`${l.invoice.invoiceNo}|${l.productId}`, num(l.unitPrice)]));

    const rows = products.map((p) => {
      const events: CostEvent[] = movements
        .filter((m) => m.productId === p.id)
        .map((m) => {
          const isIn = m.type === "RECEIVE" || m.type === "ADJUST_IN" || m.type === "RETURN_IN";
          return {
            date: m.createdAt,
            type: isIn ? ("IN" as const) : ("OUT" as const),
            qty: num(m.qty),
            unitCost: num(m.unitCost),
            unitPrice: m.type === "SALE" ? priceOf.get(`${m.reference}|${p.id}`) ?? 0 : 0,
          };
        });
      const fifo = simulate(events, "FIFO");
      const lifo = simulate(events, "LIFO");
      const wac = simulate(events, "WAC");
      const openLots = lots
        .filter((l) => l.productId === p.id)
        .map((l) => ({ id: l.id, receivedAt: l.receivedAt, qtyRemaining: num(l.qtyRemaining), unitCost: num(l.unitCost) }));
      const avg = weightedAverageCost(openLots);
      const purchases = events.filter((e) => e.type === "IN");
      const lastCost = purchases.at(-1)?.unitCost ?? num(p.unitCost);
      const unitCost = num(p.unitCost);
      const override = p.sellPriceOverride === null ? null : num(p.sellPriceOverride);
      return {
        productId: p.id,
        itemCode: p.itemCode,
        name: p.name,
        category: p.category?.name ?? "",
        supplier: p.supplier?.name ?? "",
        qtyOnHand: num(p.qtyOnHand),
        standardCost: unitCost,
        lastCost,
        weightedAverageCost: avg,
        stockValue: inventoryValue(openLots),
        methods: { FIFO: fifo, LIFO: lifo, WAC: wac },
        prices: tiers.map((t) => {
          const price = sellingPrice({ unitCost, sellPriceOverride: override }, num(t.markupPct));
          return { tier: t.code, price, marginOnAvgCost: marginPct(price, avg || unitCost) };
        }),
        lots: openLots,
      };
    });

    const totals = (["FIFO", "LIFO", "WAC"] as const).map((m) => ({
      method: m,
      cogs: round2(rows.reduce((s, r) => s + r.methods[m].cogs, 0)),
      revenue: round2(rows.reduce((s, r) => s + r.methods[m].revenue, 0)),
      grossProfit: round2(rows.reduce((s, r) => s + r.methods[m].grossProfit, 0)),
      endingValue: round2(rows.reduce((s, r) => s + r.methods[m].endingValue, 0)),
    }));
    res.json({ bookMethod: settings.costingMethod, totals, rows });
  })
);

export default router;
