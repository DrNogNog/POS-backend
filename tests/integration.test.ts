// End-to-end test of the full business flow through the real API.
// Skipped unless TEST_DB_URL_A and TEST_DB_URL_B point at throwaway databases.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { hasDatabase, startApi } from "./support/harness.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const r2 = (n: number) => Math.round(n * 100) / 100;
const daysAgo = (n: number) => new Date(Date.now() - n * 86400000).toISOString();

describe("POS end to end", { skip: !hasDatabase && "set TEST_DB_URL" }, () => {
  let api: Awaited<ReturnType<typeof startApi>>;
  let token = "";
  const call = (m: string, u: string, body?: unknown) => api.call(m, u, { body, token });
  const ids: Record<string, number> = {};

  before(async () => {
    api = await startApi();
  });
  after(async () => api?.stop());

  test("login is required", async () => {
    assert.equal((await api.call("GET", "/products")).status, 401);
    const bad = await api.call("POST", "/auth/login", { body: { email: "owner@test.local", password: "nope" } });
    assert.equal(bad.status, 401);
    const ok = await api.call("POST", "/auth/login", { body: { email: "owner@test.local", password: "correct-horse-battery" } });
    assert.equal(ok.status, 200, JSON.stringify(ok.data));
    token = ok.data.token;
    const me = await call("GET", "/auth/me");
    assert.equal(me.data.user.role, "OWNER");
    // The store is whatever database (drive) the server runs on, named in Settings
    assert.equal(me.data.store.name, "Test Store");
    assert.ok(me.data.store.id, "store has an id (from the data directory)");
  });

  test("seed sets up tax and price levels", async () => {
    const a = await call("GET", "/settings");
    assert.equal(Number(a.data.taxRates.find((t: Any) => t.isDefault).ratePct), 8.875);
    assert.equal(a.data.priceTiers.map((t: Any) => t.code).join(","), "AA,A,B,C,D");
  });

  test("supplier with contract terms", async () => {
    const res = await call("POST", "/suppliers", {
      name: "Champion Cabinet Supply",
      paymentTermsDays: 30,
      tradeDiscountPct: 61,
      earlyPayDiscountPct: 2,
      earlyPayDiscountDays: 10,
      lateFeePct: 1.5,
      contractNotes: "2025 price list, 61% off list",
    });
    assert.equal(res.status, 201, JSON.stringify(res.data));
    ids.supplier = res.data.id;
  });

  test("product: price in = list less supplier discount", async () => {
    const cats = (await call("GET", "/settings")).data.categories;
    const res = await call("POST", "/products", {
      itemCode: "w0930",
      name: "Wall Cabinet 9x30",
      listPrice: 100,
      supplierDiscountPct: 61,
      supplierId: ids.supplier,
      categoryId: cats.find((c: Any) => c.name === "Cabinets").id,
      reorderPoint: 5,
    });
    assert.equal(res.status, 201, JSON.stringify(res.data));
    assert.equal(res.data.itemCode, "W0930");
    assert.equal(Number(res.data.unitCost), 39);
    ids.product = res.data.id;
    const detail = await call("GET", `/products/${ids.product}`);
    assert.equal(detail.data.decoded.typeName, "Wall Cabinet");
    assert.equal(detail.data.prices.find((p: Any) => p.tier === "B").price, 62.4);
  });

  test("editing one field leaves the others alone", async () => {
    const res = await call("PUT", `/products/${ids.product}`, { reorderQty: 12 });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.equal(Number(res.data.unitCost), 39);
    assert.equal(Number(res.data.listPrice), 100);
    assert.equal(Number(res.data.reorderPoint), 5);
    const sup = await call("PUT", `/suppliers/${ids.supplier}`, { phone: "718-555-0000" });
    assert.equal(sup.data.paymentTermsDays, 30);
    assert.equal(Number(sup.data.tradeDiscountPct), 61);
  });

  test("purchase order -> receive -> bill in A/P with landed cost", async () => {
    const po = await call("POST", "/purchase-orders", {
      supplierId: ids.supplier,
      lines: [{ productId: ids.product, qty: 10 }],
    });
    assert.equal(po.status, 201, JSON.stringify(po.data));
    assert.equal(Number(po.data.subtotal), 390);
    await call("POST", `/purchase-orders/${po.data.id}/ordered`);
    const bill = await call("POST", `/purchase-orders/${po.data.id}/receive`, {
      billNo: "CH-5001",
      freight: 10,
      billDate: daysAgo(40),
    });
    assert.equal(bill.status, 201, JSON.stringify(bill.data));
    assert.equal(Number(bill.data.total), 400);
    assert.equal(Number(bill.data.tradeDiscount), 610); // saved 61% of $1,000 list
    ids.bill1 = bill.data.id;

    const po2 = await call("POST", "/purchase-orders", {
      supplierId: ids.supplier,
      lines: [{ productId: ids.product, qty: 10, listPrice: 120 }],
    });
    const bill2 = await call("POST", `/purchase-orders/${po2.data.id}/receive`, { billNo: "CH-5002" });
    assert.equal(Number(bill2.data.total), 468);
    ids.bill2 = bill2.data.id;

    const p = await call("GET", `/products/${ids.product}`);
    assert.equal(Number(p.data.qtyOnHand), 20);
    assert.equal(p.data.weightedAverageCost, 43.4); // (10 x 40 + 10 x 46.8) / 20
    assert.equal(p.data.stockValue, 868);
  });

  test("customer is remembered with terms, tier, delivery and card on file", async () => {
    const bad = await call("POST", "/customers", { name: "X", cardLast4: "4111111111111111" });
    assert.equal(bad.status, 400, "full card numbers are rejected");
    const res = await call("POST", "/customers", {
      name: "Rivera Construction",
      phone: "718-555-0101",
      billingAddress: "12 Main St\nBrooklyn, NY 11234",
      shippingAddress: "88 Job Site Rd\nBrooklyn, NY 11236",
      fulfillment: "DELIVERY",
      priceTierCode: "B",
      termsDays: 30,
      cardBrand: "Visa",
      cardLast4: "4242",
      cardExp: "09/28",
      cardToken: "tok_live_abc",
    });
    assert.equal(res.status, 201, JSON.stringify(res.data));
    ids.customer = res.data.id;
    const found = await call("GET", "/customers?q=rivera");
    assert.equal(found.data[0].cardToken, "on file", "token is never sent back");
  });

  test("estimate -> approve -> invoice (FIFO cost of goods)", async () => {
    const est = await call("POST", "/estimates", {
      customerId: ids.customer,
      billTo: "Rivera Construction\n12 Main St",
      priceTierCode: "B",
      lines: [{ productId: ids.product, qty: 12, unitPrice: 75 }],
    });
    assert.equal(est.status, 201, JSON.stringify(est.data));
    assert.equal(Number(est.data.subtotal), 900);
    assert.equal(Number(est.data.taxAmount), 79.88); // 8.875%
    const early = await call("POST", `/estimates/${est.data.id}/invoice`, {});
    assert.equal(early.status, 400, "must approve first");
    await call("POST", `/estimates/${est.data.id}/status`, { status: "APPROVED" });
    const inv = await call("POST", `/estimates/${est.data.id}/invoice`, {});
    assert.equal(inv.status, 201, JSON.stringify(inv.data));
    assert.equal(inv.data.termsDays, 30);
    assert.equal(Number(inv.data.total), 979.88);
    assert.equal(Number(inv.data.cogsTotal), 493.6); // 10 @ $40 + 2 @ $46.80
    assert.equal(Number(inv.data.earlyPayDiscountPct), 2);
    ids.invoice = inv.data.id;
    const again = await call("POST", `/estimates/${est.data.id}/invoice`, {});
    assert.equal(again.status, 400, "can't invoice twice");
  });

  test("every sale needs a customer", async () => {
    const res = await call("POST", "/invoices", {
      billTo: "Walk-in",
      lines: [{ productId: ids.product, qty: 1, unitPrice: 80 }],
    });
    assert.equal(res.status, 400);
    assert.match(res.data.error, /customer/i);
    const est = await call("POST", "/estimates", { lines: [{ productId: ids.product, qty: 1, unitPrice: 80 }] });
    assert.equal(est.status, 400);
    const walkIn = await call("POST", "/customers", { name: "Walk-in Counter" });
    assert.equal(walkIn.status, 201, JSON.stringify(walkIn.data));
    ids.walkIn = walkIn.data.id;
  });

  test("phone and fax are kept separately from the bill-to address", async () => {
    const c = await call("POST", "/customers", { name: "Fax Customer", phone: "718-555-0001", fax: "718-555-0002" });
    assert.equal(c.status, 201, JSON.stringify(c.data));
    assert.equal(c.data.fax, "718-555-0002");
    // Empty phone/fax on the estimate → the customer's numbers
    const est = await call("POST", "/estimates", { customerId: c.data.id, billTo: "Fax Customer\n1 Main St", lines: [{ description: "Measure visit", qty: 1, unitPrice: 50 }] });
    assert.equal(est.status, 201, JSON.stringify(est.data));
    assert.equal(est.data.phone, "718-555-0001");
    assert.equal(est.data.fax, "718-555-0002");
    // Typed numbers win
    const inv = await call("POST", "/invoices", { customerId: c.data.id, phone: "917-555-0003", lines: [{ description: "Measure visit", qty: 1, unitPrice: 50 }] });
    assert.equal(inv.status, 201, JSON.stringify(inv.data));
    assert.equal(inv.data.phone, "917-555-0003");
    assert.equal(inv.data.fax, "718-555-0002");
    const pdf = await call("GET", `/estimates/${est.data.id}/pdf`);
    assert.equal(pdf.status, 200);
  });

  test("not enough stock is blocked unless special order", async () => {
    const res = await call("POST", "/invoices", {
      customerId: ids.walkIn,
      billTo: "Walk-in",
      lines: [{ productId: ids.product, qty: 50, unitPrice: 75 }],
    });
    assert.equal(res.status, 400);
    assert.match(res.data.error, /Not enough stock/);
  });

  test("early payment takes the 2% discount and closes the invoice", async () => {
    const pay = await call("POST", `/invoices/${ids.invoice}/payments`, {
      amount: r2(979.88 - 19.6),
      method: "CHECK",
      reference: "Check 1201",
    });
    assert.equal(pay.status, 201, JSON.stringify(pay.data));
    assert.equal(pay.data.discountTaken, 19.6);
    const inv = await call("GET", `/invoices/${ids.invoice}`);
    assert.equal(inv.data.status, "PAID");
    assert.equal(inv.data.balance, 0);
  });

  test("register sale paid in cash", async () => {
    const res = await call("POST", "/invoices", {
      customerId: ids.walkIn,
      billTo: "Walk-in",
      lines: [{ productId: ids.product, qty: 1, unitPrice: 80 }],
      payment: { amount: 87.1, method: "CASH" },
    });
    assert.equal(res.status, 201, JSON.stringify(res.data));
    assert.equal(res.data.status, "PAID");
  });

  test("overdue invoice: late fee, collections, write-off", async () => {
    const res = await call("POST", "/invoices", {
      customerId: ids.customer,
      issueDate: daysAgo(100),
      termsDays: 30,
      lines: [{ itemCode: "INSTALL", description: "Installation labor", qty: 1, unitPrice: 500 }],
    });
    assert.equal(res.status, 201, JSON.stringify(res.data));
    ids.overdue = res.data.id;
    const view = await call("GET", `/invoices/${ids.overdue}`);
    assert.ok(view.data.daysPastDue >= 69);
    const fee = await call("POST", `/invoices/${ids.overdue}/late-fee`, {});
    assert.equal(fee.data.amount, r2(544.38 * 0.015)); // 1.5% of balance
    await call("POST", `/invoices/${ids.overdue}/collections`, { note: "ABC Collections" });
    const board = await call("GET", "/receivables");
    assert.equal(board.status, 200);
    assert.ok(board.data.aging["61-90"] > 0);
    const wo = await call("POST", `/invoices/${ids.overdue}/write-off`, { note: "Agency gave up" });
    assert.equal(wo.status, 200);
    const after = await call("GET", `/invoices/${ids.overdue}`);
    assert.equal(after.data.balance, 0);
    assert.equal(after.data.collectionStatus, "WRITTEN_OFF");
  });

  test("customer history sorted by date", async () => {
    const asc = await call("GET", `/customers/${ids.customer}?sort=issueDate&dir=asc`);
    const dates = asc.data.invoices.map((i: Any) => new Date(i.issueDate).getTime());
    assert.deepEqual(dates, [...dates].sort((a, b) => a - b));
    assert.equal(asc.data.stats.invoiceCount, 2);
  });

  test("pay supplier: late bill gets no discount, A/P board", async () => {
    const ap = await call("GET", "/payables");
    assert.equal(ap.status, 200);
    assert.equal(ap.data.aging.total, 868);
    const fee = await call("POST", `/bills/${ids.bill1}/late-fee`, {});
    assert.equal(fee.data.amount, 6); // 1.5% of $400
    const pay = await call("POST", `/bills/${ids.bill1}/payments`, { amount: 406, method: "CHECK" });
    assert.equal(pay.status, 201, JSON.stringify(pay.data));
    assert.equal(pay.data.discountTaken, 0);
    const pay2 = await call("POST", `/bills/${ids.bill2}/payments`, { amount: r2(468 * 0.98), method: "CHECK" });
    assert.equal(pay2.data.discountTaken, 9.36, "paid within 10 days -> 2% off");
  });

  test("costing screen compares FIFO / LIFO / WAC", async () => {
    const res = await call("GET", `/costing?productId=${ids.product}`);
    const row = res.data.rows[0];
    assert.equal(row.methods.FIFO.cogs, 493.6 + 46.8); // second sale draws the newer layer
    assert.equal(row.methods.LIFO.cogs, 548 + 40);
    assert.equal(row.methods.WAC.cogs, r2(13 * 43.4));
    assert.equal(res.data.bookMethod, "FIFO");
  });

  test("partial payment at the counter leaves the rest on account", async () => {
    const res = await call("POST", "/invoices", {
      customerId: ids.walkIn,
      lines: [{ productId: ids.product, qty: 1, unitPrice: 80 }],
      payment: { amount: 50, method: "CREDIT" },
    });
    assert.equal(res.status, 201, JSON.stringify(res.data));
    assert.equal(res.data.status, "PARTIAL");
    const inv = await call("GET", `/invoices/${res.data.id}`);
    assert.equal(inv.data.balance, r2(87.1 - 50));
  });

  test("invoice list says whether the sale needed an approval", async () => {
    const needed = await call("GET", "/invoices?approval=needed");
    assert.ok(needed.data.items.length >= 1);
    assert.ok(needed.data.items.every((i: { estimate: unknown }) => i.estimate));
    const none = await call("GET", "/invoices?approval=none");
    assert.ok(none.data.items.length >= 1);
    assert.ok(none.data.items.every((i: { estimate: unknown }) => !i.estimate));
  });

  test("invoice PDF prints (plain style)", async () => {
    const pdf = await call("GET", `/invoices/${ids.invoice}/pdf`);
    assert.equal(pdf.status, 200);
  });

  test("estimates and approvals count as promised stock", async () => {
    const imp = await call("POST", "/products/import", {
      rows: [{ itemCode: "ZT-COMMIT", name: "Commit test cabinet", listPrice: 20, supplierDiscountPct: 50, qtyOnHand: 5 }],
    });
    assert.equal(imp.status, 200, JSON.stringify(imp.data));
    const found = await call("GET", "/products?q=ZT-COMMIT");
    const pid = found.data.items[0].id;
    ids.commit = pid;
    const line = (qty: number) => [{ productId: pid, qty, unitPrice: 15 }];

    let av = await call("GET", `/products/availability?ids=${pid}`);
    assert.deepEqual([av.data[0].onHand, av.data[0].available], [5, 5]);

    const first = await call("POST", "/estimates", { customerId: ids.walkIn, lines: line(3) });
    assert.equal(first.status, 201, JSON.stringify(first.data));
    av = await call("GET", `/products/availability?ids=${pid}`);
    assert.equal(av.data[0].pending, 3);
    assert.equal(av.data[0].available, 2);
    // Editing the same estimate doesn't count against itself
    const edit = await call("PUT", `/estimates/${first.data.id}`, { customerId: ids.walkIn, lines: line(5) });
    assert.equal(edit.status, 200, JSON.stringify(edit.data));
    await call("PUT", `/estimates/${first.data.id}`, { customerId: ids.walkIn, lines: line(3) });

    const second = await call("POST", "/estimates", { customerId: ids.walkIn, lines: line(3) });
    assert.equal(second.status, 400);
    assert.match(second.data.error, /already promised/);
    const anyway = await call("POST", "/estimates", { customerId: ids.walkIn, lines: line(3), allowShortage: true });
    assert.equal(anyway.status, 201, JSON.stringify(anyway.data));

    // A direct sale can't take stock promised to the estimates
    const sale = await call("POST", "/invoices", { customerId: ids.walkIn, lines: line(1) });
    assert.equal(sale.status, 400);
    assert.match(sale.data.error, /Special order/);

    // Invoicing the approved estimate itself is fine (its own units aren't "promised away")
    await call("POST", `/estimates/${anyway.data.id}/status`, { status: "REJECTED" });
    await call("POST", `/estimates/${first.data.id}/status`, { status: "APPROVED" });
    const inv = await call("POST", `/estimates/${first.data.id}/invoice`, {});
    assert.equal(inv.status, 201, JSON.stringify(inv.data));
    av = await call("GET", `/products/availability?ids=${pid}`);
    assert.deepEqual([av.data[0].onHand, av.data[0].available], [2, 2]);
  });

  test("adding stock averages the cost in (or replaces / keeps it)", async () => {
    // 2 on hand at $10; add 2 at $20 → average $15
    const add = await call("POST", `/products/${ids.commit}/adjust`, { qtyChange: 2, unitCost: 20, reason: "Count" });
    assert.equal(add.status, 200, JSON.stringify(add.data));
    let p = await call("GET", `/products/${ids.commit}`);
    assert.equal(Number(p.data.unitCost), 15);
    await call("POST", `/products/${ids.commit}/adjust`, { qtyChange: 1, unitCost: 30, reason: "Count", costUpdate: "keep" });
    p = await call("GET", `/products/${ids.commit}`);
    assert.equal(Number(p.data.unitCost), 15);
    await call("POST", `/products/${ids.commit}/adjust`, { qtyChange: 1, unitCost: 12, reason: "Count", costUpdate: "replace" });
    p = await call("GET", `/products/${ids.commit}`);
    assert.equal(Number(p.data.unitCost), 12);
  });

  test("invoices remember their price level for the margin report", async () => {
    const sale = await call("POST", "/invoices", {
      customerId: ids.walkIn,
      priceTierCode: "B",
      lines: [{ productId: ids.commit, qty: 1, unitPrice: 30 }],
    });
    assert.equal(sale.status, 201, JSON.stringify(sale.data));
    const rep = await call("GET", "/costing/invoices?level=B");
    assert.equal(rep.status, 200, JSON.stringify(rep.data));
    const row = rep.data.rows.find((r: { id: number }) => r.id === sale.data.id);
    assert.ok(row, "invoice listed under level B");
    assert.equal(row.priceTierCode, "B");
    assert.equal(row.netSales, 30);
    assert.ok(rep.data.levels.some((l: { level: string }) => l.level === "B"));
  });

  test("void puts stock back and reverses the books", async () => {
    const sale = await call("POST", "/invoices", {
      customerId: ids.walkIn,
      billTo: "Walk-in",
      lines: [{ productId: ids.product, qty: 2, unitPrice: 80 }],
    });
    const before = Number((await call("GET", `/products/${ids.product}`)).data.qtyOnHand);
    const v = await call("POST", `/invoices/${sale.data.id}/void`, { reason: "Customer changed mind" });
    assert.equal(v.status, 200, JSON.stringify(v.data));
    const afterQty = Number((await call("GET", `/products/${ids.product}`)).data.qtyOnHand);
    assert.equal(afterQty, before + 2);
  });

  test("stock adjustment and payroll post to the books", async () => {
    const adj = await call("POST", `/products/${ids.product}/adjust`, { qtyChange: -1, reason: "Damaged in warehouse" });
    assert.equal(adj.status, 200, JSON.stringify(adj.data));
    const emp = await call("POST", "/payroll/employees", { name: "Ana", payType: "HOURLY", payRate: 20 });
    assert.equal(emp.status, 201, JSON.stringify(emp.data));
    const preview = await call("POST", "/payroll/runs/preview", {});
    assert.equal(preview.data[0].grossPay, 1600);
    const run = await call("POST", "/payroll/runs", {
      periodStart: daysAgo(14),
      periodEnd: daysAgo(1),
      payDate: daysAgo(0),
      post: true,
      paychecks: [{ ...preview.data[0], federalTax: 120, stateTax: 50 }],
    });
    assert.equal(run.status, 201, JSON.stringify(run.data));
  });

  test("the books balance", async () => {
    const tb = await call("GET", "/reports/trial-balance");
    assert.equal(tb.data.inBalance, true, JSON.stringify(tb.data.rows.filter((r: Any) => r.debit || r.credit)));
    const bs = await call("GET", "/reports/balance-sheet");
    assert.equal(bs.data.totals.assets, bs.data.totals.liabilitiesAndEquity);
    // Inventory on the books = value of the cost layers on hand
    const all = await call("GET", "/products?limit=500");
    let layers = 0;
    for (const item of all.data.items) layers += (await call("GET", `/products/${item.id}`)).data.stockValue;
    const invAcct = bs.data.assets.find((a: Any) => a.code === "1200").balance;
    assert.ok(Math.abs(invAcct - layers) < 0.05, `books ${invAcct} vs layers ${layers}`);
    const pl = await call("GET", "/reports/income-statement");
    assert.equal(pl.status, 200);
    assert.ok(pl.data.totals.grossProfit > 0);
    const dash = await call("GET", "/reports/dashboard");
    assert.equal(dash.status, 200, JSON.stringify(dash.data));
  });

  test("PDFs render", async () => {
    for (const url of [`/invoices/${ids.invoice}/pdf`, `/bills/${ids.bill1}/pdf`, "/estimates/1/pdf", "/purchase-orders/1/pdf"]) {
      const res = await call("GET", url);
      assert.equal(res.status, 200, url);
      assert.match(res.type, /pdf/);
    }
  });

  test("history records everything", async () => {
    const h = await call("GET", "/history?limit=500");
    const actions = new Set(h.data.items.map((i: Any) => `${i.entityType}:${i.action}`));
    for (const a of ["Invoice:CREATED", "Invoice:PAYMENT", "Invoice:LATE_FEE", "Invoice:COLLECTIONS", "Invoice:WRITE_OFF", "Estimate:APPROVED", "Bill:RECEIVED", "Bill:PAYMENT", "Product:CREATED", "Customer:CREATED", "Payroll:POSTED"]) {
      assert.ok(actions.has(a), `missing ${a}`);
    }
  });

  test("price list import", async () => {
    const res = await call("POST", "/products/import", {
      rows: [
        { itemCode: "AL-B09", name: "Avalon Base Cabinet 9\"", category: "Cabinets", collection: "Avalon", supplier: "Champion Cabinet Supply", listPrice: 210.56, supplierDiscountPct: 61 },
        { itemCode: "W0930", name: "Wall Cabinet 9x30 (updated)", listPrice: 100, supplierDiscountPct: 61 },
      ],
    });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.deepEqual(res.data, { created: 1, updated: 1 });
  });

  test("roles: cashier can sell but not run payroll", async () => {
    await call("POST", "/auth/users", { email: "cash@test.local", name: "Cashier", role: "CASHIER", password: "cashier-pass-1" });
    const login = await api.call("POST", "/auth/login", { body: { email: "cash@test.local", password: "cashier-pass-1" } });
    const t = login.data.token;
    assert.equal((await api.call("GET", "/payroll/employees", { token: t })).status, 403);
    assert.equal((await api.call("GET", "/products", { token: t })).status, 200);
    // A disabled login is refused
    const users = await call("GET", "/auth/users");
    const cashier = users.data.find((u: Any) => u.email === "cash@test.local");
    await call("PUT", `/auth/users/${cashier.id}`, { active: false });
    assert.equal((await api.call("GET", "/products", { token: t })).status, 403);
  });
});
