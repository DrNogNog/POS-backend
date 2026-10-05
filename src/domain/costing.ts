// -----------------------------------------------------------------------------
// Inventory costing: FIFO, LIFO and Weighted Average (WAC).
//
// Stock is kept as "lots" (layers): each purchase is one lot with its own
// unit cost. When we sell, we take quantity out of lots:
//
//   FIFO  First In, First Out   -> oldest lots first
//   LIFO  Last In, First Out    -> newest lots first
//   WAC   Weighted Average Cost -> every unit costs the average of all units
//                                  on hand; lots shrink proportionally so the
//                                  average stays the same after the sale.
//
// These functions are PURE (no database) so they are easy to test and are
// also used by the Costing screen to compare all three methods side by side.
// -----------------------------------------------------------------------------
import { round2, round3, round4 } from "../lib/money.js";

export type CostMethod = "FIFO" | "LIFO" | "WAC";

export interface Lot {
  id: number | string;
  receivedAt: Date;
  qtyRemaining: number;
  unitCost: number;
}

export interface LotDraw {
  lotId: Lot["id"];
  qty: number;
  unitCost: number;
}

export interface ConsumeResult {
  draws: LotDraw[];
  /** Total cost of the units taken (COGS for this sale). */
  totalCost: number;
  /** Average unit cost of the units taken. */
  unitCost: number;
  /** Quantity we could not find in stock (sold more than on hand). */
  shortQty: number;
}

/** Weighted average unit cost of what is on hand. */
export function weightedAverageCost(lots: Lot[]): number {
  const qty = lots.reduce((s, l) => s + l.qtyRemaining, 0);
  if (qty <= 0) return 0;
  const value = lots.reduce((s, l) => s + l.qtyRemaining * l.unitCost, 0);
  return round4(value / qty);
}

export function inventoryValue(lots: Lot[]): number {
  return round2(lots.reduce((s, l) => s + l.qtyRemaining * l.unitCost, 0));
}

/**
 * Work out which lots a sale of `qty` units draws from, and what it cost.
 * Does not change the lots passed in.
 *
 * If there is not enough stock, the missing units are costed at
 * `fallbackUnitCost` (the product's standard cost) and reported in shortQty.
 */
export function consumeLots(
  lots: Lot[],
  qty: number,
  method: CostMethod,
  fallbackUnitCost = 0
): ConsumeResult {
  const open = lots.filter((l) => l.qtyRemaining > 0);
  const draws: LotDraw[] = [];
  let remaining = round3(qty);

  if (method === "WAC") {
    const onHand = open.reduce((s, l) => s + l.qtyRemaining, 0);
    const avg = weightedAverageCost(open);
    const take = Math.min(remaining, onHand);
    if (take > 0) {
      // Shrink every lot by the same fraction so the average is unchanged.
      const fraction = take / onHand;
      let allocated = 0;
      open.forEach((lot, i) => {
        const isLast = i === open.length - 1;
        const q = isLast ? round3(take - allocated) : round3(lot.qtyRemaining * fraction);
        allocated = round3(allocated + q);
        if (q > 0) draws.push({ lotId: lot.id, qty: q, unitCost: avg });
      });
    }
    remaining = round3(remaining - take);
    const shortCost = remaining * (avg || fallbackUnitCost);
    const totalCost = round2(take * avg + shortCost);
    return {
      draws,
      totalCost,
      unitCost: qty > 0 ? round4(totalCost / qty) : 0,
      shortQty: remaining,
    };
  }

  const ordered = [...open].sort((a, b) => {
    const diff = a.receivedAt.getTime() - b.receivedAt.getTime();
    const byId = String(a.id).localeCompare(String(b.id), undefined, { numeric: true });
    return method === "FIFO" ? diff || byId : -diff || -byId;
  });

  let cost = 0;
  for (const lot of ordered) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, lot.qtyRemaining);
    draws.push({ lotId: lot.id, qty: round3(take), unitCost: lot.unitCost });
    cost += take * lot.unitCost;
    remaining = round3(remaining - take);
  }
  if (remaining > 0) cost += remaining * fallbackUnitCost;
  const totalCost = round2(cost);
  return { draws, totalCost, unitCost: qty > 0 ? round4(totalCost / qty) : 0, shortQty: remaining };
}

/** Apply draws to lots and return the new lot list (pure). */
export function applyDraws(lots: Lot[], draws: LotDraw[]): Lot[] {
  const byId = new Map(draws.map((d) => [String(d.lotId), 0]));
  for (const d of draws) byId.set(String(d.lotId), (byId.get(String(d.lotId)) || 0) + d.qty);
  return lots.map((l) => ({
    ...l,
    qtyRemaining: round3(l.qtyRemaining - (byId.get(String(l.id)) || 0)),
  }));
}

// ---- Simulation for the Costing screen --------------------------------------

export interface CostEvent {
  date: Date;
  type: "IN" | "OUT";
  qty: number;
  /** For IN: purchase unit cost. For OUT: ignored. */
  unitCost?: number;
  /** For OUT: the selling price per unit (to show gross margin). */
  unitPrice?: number;
}

export interface SimulationResult {
  method: CostMethod;
  unitsIn: number;
  unitsOut: number;
  purchases: number;
  cogs: number;
  revenue: number;
  grossProfit: number;
  grossMarginPct: number;
  endingQty: number;
  endingValue: number;
  endingUnitCost: number;
}

/**
 * Replay a product's history (purchases and sales in date order) under one
 * costing method. Used to compare FIFO vs LIFO vs WAC.
 */
export function simulate(events: CostEvent[], method: CostMethod): SimulationResult {
  let lots: Lot[] = [];
  let unitsIn = 0;
  let unitsOut = 0;
  let purchases = 0;
  let cogs = 0;
  let revenue = 0;
  const sorted = [...events].sort((a, b) => a.date.getTime() - b.date.getTime());
  sorted.forEach((e, i) => {
    if (e.type === "IN") {
      lots.push({ id: i, receivedAt: e.date, qtyRemaining: e.qty, unitCost: e.unitCost ?? 0 });
      unitsIn += e.qty;
      purchases += e.qty * (e.unitCost ?? 0);
    } else {
      const res = consumeLots(lots, e.qty, method, lots.at(-1)?.unitCost ?? 0);
      lots = applyDraws(lots, res.draws);
      unitsOut += e.qty;
      cogs += res.totalCost;
      revenue += e.qty * (e.unitPrice ?? 0);
    }
  });
  const endingQty = round3(lots.reduce((s, l) => s + Math.max(0, l.qtyRemaining), 0));
  const endingValue = inventoryValue(lots.filter((l) => l.qtyRemaining > 0));
  const grossProfit = round2(revenue - cogs);
  return {
    method,
    unitsIn: round3(unitsIn),
    unitsOut: round3(unitsOut),
    purchases: round2(purchases),
    cogs: round2(cogs),
    revenue: round2(revenue),
    grossProfit,
    grossMarginPct: revenue > 0 ? round2((grossProfit / revenue) * 100) : 0,
    endingQty,
    endingValue,
    endingUnitCost: endingQty > 0 ? round4(endingValue / endingQty) : 0,
  };
}
