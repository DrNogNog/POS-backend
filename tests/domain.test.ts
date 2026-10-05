// Unit tests for the accounting rules. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { consumeLots, simulate, weightedAverageCost } from "../src/domain/costing.js";
import { applyPayment, agingBucket, agingSummary, balanceDue, lateFeeAmount, statusFor } from "../src/domain/terms.js";
import { documentTotals } from "../src/domain/documentTotals.js";
import { netCost, tierPrice, sellingPrice, marginPct } from "../src/domain/pricing.js";
import { balanced, saleEntry, customerPaymentEntry, payrollEntry, billEntry, supplierPaymentEntry } from "../src/domain/accounts.js";
import { receivablesHealth } from "../src/domain/receivablesHealth.js";
import { grossPay, netPay } from "../src/domain/payroll.js";
import { decodeItemCode } from "../src/domain/itemCodes.js";
import { round2 } from "../src/lib/money.js";
import { nextNumber } from "../src/lib/numbering.js";

const d = (s: string) => new Date(s + "T12:00:00");
const lots = [
  { id: 1, receivedAt: d("2026-01-01"), qtyRemaining: 10, unitCost: 40 },
  { id: 2, receivedAt: d("2026-02-01"), qtyRemaining: 10, unitCost: 46.8 },
];

test("FIFO takes the oldest cost layers first", () => {
  const r = consumeLots(lots, 12, "FIFO");
  assert.equal(r.totalCost, 493.6); // 10 x 40 + 2 x 46.80
  assert.deepEqual(r.draws.map((x) => [x.lotId, x.qty]), [[1, 10], [2, 2]]);
  assert.equal(r.shortQty, 0);
});

test("LIFO takes the newest cost layers first", () => {
  const r = consumeLots(lots, 12, "LIFO");
  assert.equal(r.totalCost, 548); // 10 x 46.80 + 2 x 40
});

test("Weighted average costs every unit at the average", () => {
  assert.equal(weightedAverageCost(lots), 43.4);
  const r = consumeLots(lots, 12, "WAC");
  assert.equal(r.totalCost, 520.8); // 12 x 43.40
  // Lots shrink proportionally, so the average of what's left is unchanged
  const left = lots.map((l) => ({ ...l, qtyRemaining: l.qtyRemaining - (r.draws.find((x) => x.lotId === l.id)?.qty ?? 0) }));
  assert.equal(weightedAverageCost(left), 43.4);
});

test("Selling more than on hand reports the shortage", () => {
  const r = consumeLots(lots, 25, "FIFO", 50);
  assert.equal(r.shortQty, 5);
  assert.equal(r.totalCost, round2(400 + 468 + 5 * 50));
});

test("simulate compares methods over a history", () => {
  const events = [
    { date: d("2026-01-01"), type: "IN" as const, qty: 10, unitCost: 40 },
    { date: d("2026-02-01"), type: "IN" as const, qty: 10, unitCost: 46.8 },
    { date: d("2026-03-01"), type: "OUT" as const, qty: 12, unitPrice: 75 },
  ];
  const f = simulate(events, "FIFO");
  const l = simulate(events, "LIFO");
  const w = simulate(events, "WAC");
  assert.equal(f.cogs, 493.6);
  assert.equal(l.cogs, 548);
  assert.equal(w.cogs, 520.8);
  assert.equal(f.revenue, 900);
  assert.equal(f.endingValue, round2(8 * 46.8));
  assert.equal(l.endingValue, 320);
  // Same goods in total: COGS + ending inventory = purchases, for every method
  for (const r of [f, l, w]) assert.equal(round2(r.cogs + r.endingValue), 868);
});

test("Early-payment discount (2/10 net 30)", () => {
  const item = {
    issueDate: d("2026-03-01"),
    dueDate: d("2026-03-31"),
    total: 1000,
    amountPaid: 0,
    discountsTaken: 0,
    lateFees: 0,
    earlyPayDiscountPct: 2,
    earlyPayDiscountDays: 10,
  };
  const early = applyPayment(item, 980, d("2026-03-08"));
  assert.deepEqual([early.cashApplied, early.discountTaken, early.newBalance], [980, 20, 0]);
  const late = applyPayment(item, 980, d("2026-03-20"));
  assert.deepEqual([late.cashApplied, late.discountTaken, late.newBalance], [980, 0, 20]);
  const partial = applyPayment(item, 500, d("2026-03-05"));
  assert.equal(partial.discountTaken, 0, "no discount on a partial payment");
  assert.equal(applyPayment(item, 1200, d("2026-03-20")).overpayment, 200);
});

test("Balance, status, late fee", () => {
  const base = { total: 500, amountPaid: 200, discountsTaken: 0, lateFees: 7.5, writtenOff: 0 };
  assert.equal(balanceDue(base), 307.5);
  assert.equal(statusFor(base), "PARTIAL");
  assert.equal(statusFor({ ...base, amountPaid: 507.5 }), "PAID");
  assert.equal(lateFeeAmount(300, 1.5, 0), 4.5);
  assert.equal(lateFeeAmount(300, 1.5, 25), 29.5);
  assert.equal(lateFeeAmount(0, 1.5, 25), 0);
});

test("Aging buckets", () => {
  const today = d("2026-06-30");
  assert.equal(agingBucket(d("2026-07-15"), today), "current");
  assert.equal(agingBucket(d("2026-06-15"), today), "1-30");
  assert.equal(agingBucket(d("2026-05-15"), today), "31-60");
  assert.equal(agingBucket(d("2026-04-15"), today), "61-90");
  assert.equal(agingBucket(d("2026-01-15"), today), "90+");
  const s = agingSummary(
    [
      { dueDate: d("2026-07-15"), balance: 100 },
      { dueDate: d("2026-01-15"), balance: 50 },
    ],
    today
  );
  assert.equal(s.total, 150);
  assert.equal(s["90+"], 50);
});

test("Document totals: discount spread before tax, non-taxable lines", () => {
  const t = documentTotals(
    [
      { qty: 2, unitPrice: 100, taxable: true },
      { qty: 1, unitPrice: 100, taxable: false },
    ],
    30,
    8.875
  );
  assert.equal(t.subtotal, 300);
  assert.equal(t.taxableBase, 180); // 200 taxable - 2/3 of the $30 discount
  assert.equal(t.taxAmount, 15.98);
  assert.equal(t.total, 285.98);
});

test("Pricing: list less discount, then tier markup", () => {
  assert.equal(netCost(100, 61), 39);
  assert.equal(tierPrice(39, 60), 62.4);
  assert.equal(sellingPrice({ unitCost: 39, sellPriceOverride: 70 }, 60), 70);
  assert.equal(marginPct(62.4, 39), 37.5);
});

test("Journal entries always balance", () => {
  for (const lines of [
    saleEntry({ total: 1088.75, netSales: 1000, tax: 88.75, cogs: 600 }),
    customerPaymentEntry({ cash: 980, discount: 20, method: "CASH" }),
    billEntry({ debitAccount: "1200", amount: 390, freight: 10, tax: 0 }),
    supplierPaymentEntry({ cash: 392, discount: 8, method: "CHECK" }),
    payrollEntry({ gross: 2000, net: 1600, employerTaxes: 153 }),
  ]) {
    const dr = round2(lines.reduce((s, l) => s + l.debit, 0));
    const cr = round2(lines.reduce((s, l) => s + l.credit, 0));
    assert.equal(dr, cr);
  }
  assert.throws(() => balanced([{ account: "1000", debit: 5 }]));
});

test("A/R health: too high, healthy, too low", () => {
  const base = { periodDays: 90, highDso: 45, lowDso: 10 };
  assert.equal(receivablesHealth({ ...base, arBalance: 60000, overdueBalance: 30000, salesInPeriod: 90000, creditSalesInPeriod: 60000 }).level, "HIGH");
  assert.equal(receivablesHealth({ ...base, arBalance: 20000, overdueBalance: 1000, salesInPeriod: 90000, creditSalesInPeriod: 50000 }).level, "HEALTHY");
  assert.equal(receivablesHealth({ ...base, arBalance: 500, overdueBalance: 0, salesInPeriod: 90000, creditSalesInPeriod: 1000 }).level, "LOW");
  assert.equal(receivablesHealth({ ...base, arBalance: 0, overdueBalance: 0, salesInPeriod: 0, creditSalesInPeriod: 0 }).level, "NO_DATA");
});

test("Payroll gross and net", () => {
  assert.equal(grossPay({ payType: "HOURLY", payRate: 20, payFrequency: "BIWEEKLY", regularHours: 80, overtimeHours: 4 }), 1720);
  assert.equal(grossPay({ payType: "SALARY", payRate: 52000, payFrequency: "WEEKLY", regularHours: 0, overtimeHours: 0 }), 1000);
  assert.equal(netPay(1000, { federalTax: 100, stateTax: 40, socialSecurity: 62, medicare: 14.5, otherDeductions: 0 }), 783.5);
});

test("Item codes decode into plain English", () => {
  const w = decodeItemCode("W0930");
  assert.equal(w.typeName, "Wall Cabinet");
  assert.equal(w.widthIn, 9);
  assert.equal(w.heightIn, 30);
  assert.equal(w.doors, "single door");
  assert.equal(w.shelves, "2 adjustable shelves");

  const wdc = decodeItemCode("WDC2430");
  assert.equal(wdc.typeName, "Wall Diagonal Corner Cabinet");
  assert.deepEqual([wdc.widthIn, wdc.heightIn], [24, 30]);

  const db = decodeItemCode("AL-DB18-3");
  assert.equal(db.collection, "Avalon");
  assert.equal(db.typeName, "Drawer Base Cabinet");
  assert.equal(db.drawers, 3);

  assert.equal(decodeItemCode("W3630").doors, "double (butt) doors");
  assert.equal(decodeItemCode("W362424").depthIn, 24);
  assert.equal(decodeItemCode("NV-30GR").typeName, "Glass Rack");
  assert.match(decodeItemCode("Q001-60D-3").summary, /Calacatta Delphi.*60" vanity, double sinks, 3 faucet holes/);
  assert.equal(decodeItemCode("ZZZ").recognized, false);
});

test("Document numbering", () => {
  assert.equal(nextNumber([], "INV-"), "INV-1001");
  assert.equal(nextNumber(["INV-1001", "INV-1009", "X-5000"], "INV-"), "INV-1010");
});
