// -----------------------------------------------------------------------------
// Chart of accounts and the journal entries each business event creates.
//
// Double-entry rule: every entry's DEBITS must equal its CREDITS.
//
//   Event                       Debit                      Credit
//   --------------------------  -------------------------  ---------------------
//   Sale on invoice             A/R (total)                Sales, Sales Tax Payable
//                               COGS                       Inventory
//   Customer pays               Cash / Bank, Sales Disc.   A/R
//   Late fee on customer        A/R                        Late Fee Income
//   Write off bad debt          Bad Debt Expense           A/R
//   Receive stock + bill        Inventory (+freight)       A/P
//   Non-inventory bill          Expense account            A/P
//   Pay supplier                A/P                        Cash / Bank, Purchase Disc.
//   Supplier late fee           Late Fees Expense          A/P
//   Opening stock / count up    Inventory                  Opening Balance Equity
//   Shrinkage / count down      Inventory Shrinkage        Inventory
//   Payroll                     Wages, Payroll Tax Exp.    Cash, Payroll Liabilities
// -----------------------------------------------------------------------------
import type { AccountType } from "@prisma/client";
import { round2 } from "../lib/money.js";

export const ACC = {
  CASH: "1000",
  BANK: "1010",
  AR: "1100",
  INVENTORY: "1200",
  AP: "2000",
  SALES_TAX_PAYABLE: "2100",
  PAYROLL_LIABILITIES: "2200",
  OWNER_EQUITY: "3000",
  OPENING_BALANCE_EQUITY: "3900",
  SALES: "4000",
  SALES_DISCOUNTS: "4100",
  LATE_FEE_INCOME: "4200",
  COGS: "5000",
  PURCHASE_DISCOUNTS: "5100",
  INVENTORY_SHRINKAGE: "5200",
  WAGES: "6000",
  PAYROLL_TAX_EXPENSE: "6010",
  BAD_DEBT: "6100",
  LATE_FEES_EXPENSE: "6200",
  RENT: "6300",
  UTILITIES: "6400",
  DELIVERY: "6500",
  OFFICE: "6600",
  OTHER_EXPENSE: "6900",
} as const;

export const CHART_OF_ACCOUNTS: {
  code: string;
  name: string;
  type: AccountType;
  isCurrent?: boolean;
}[] = [
  { code: ACC.CASH, name: "Cash on Hand", type: "ASSET" },
  { code: ACC.BANK, name: "Bank (card & check deposits)", type: "ASSET" },
  { code: ACC.AR, name: "Accounts Receivable", type: "ASSET" },
  { code: ACC.INVENTORY, name: "Inventory", type: "ASSET" },
  { code: ACC.AP, name: "Accounts Payable", type: "LIABILITY" },
  { code: ACC.SALES_TAX_PAYABLE, name: "Sales Tax Payable", type: "LIABILITY" },
  { code: ACC.PAYROLL_LIABILITIES, name: "Payroll Liabilities", type: "LIABILITY" },
  { code: ACC.OWNER_EQUITY, name: "Owner's Equity", type: "EQUITY", isCurrent: false },
  { code: ACC.OPENING_BALANCE_EQUITY, name: "Opening Balance Equity", type: "EQUITY", isCurrent: false },
  { code: ACC.SALES, name: "Sales", type: "REVENUE" },
  { code: ACC.SALES_DISCOUNTS, name: "Sales Discounts (early payment)", type: "CONTRA_REVENUE" },
  { code: ACC.LATE_FEE_INCOME, name: "Late Fee Income", type: "REVENUE" },
  { code: ACC.COGS, name: "Cost of Goods Sold", type: "COGS" },
  { code: ACC.PURCHASE_DISCOUNTS, name: "Purchase Discounts (early payment)", type: "COGS" },
  { code: ACC.INVENTORY_SHRINKAGE, name: "Inventory Shrinkage & Adjustments", type: "COGS" },
  { code: ACC.WAGES, name: "Wages & Salaries", type: "EXPENSE" },
  { code: ACC.PAYROLL_TAX_EXPENSE, name: "Payroll Tax Expense", type: "EXPENSE" },
  { code: ACC.BAD_DEBT, name: "Bad Debt Expense", type: "EXPENSE" },
  { code: ACC.LATE_FEES_EXPENSE, name: "Late Fees Paid", type: "EXPENSE" },
  { code: ACC.RENT, name: "Rent", type: "EXPENSE" },
  { code: ACC.UTILITIES, name: "Utilities", type: "EXPENSE" },
  { code: ACC.DELIVERY, name: "Delivery & Freight", type: "EXPENSE" },
  { code: ACC.OFFICE, name: "Office & Supplies", type: "EXPENSE" },
  { code: ACC.OTHER_EXPENSE, name: "Other Expenses", type: "EXPENSE" },
];

/** Cash goes to the till, cards and checks go to the bank. */
export function cashAccountFor(method: string): string {
  return method === "CASH" ? ACC.CASH : ACC.BANK;
}

export interface EntryLine {
  account: string;
  debit?: number;
  credit?: number;
}

/** Drop zero lines and round. Throws if debits don't equal credits. */
export function balanced(lines: EntryLine[]): { account: string; debit: number; credit: number }[] {
  const clean = lines
    .map((l) => ({ account: l.account, debit: round2(l.debit ?? 0), credit: round2(l.credit ?? 0) }))
    .filter((l) => l.debit !== 0 || l.credit !== 0);
  const dr = round2(clean.reduce((s, l) => s + l.debit, 0));
  const cr = round2(clean.reduce((s, l) => s + l.credit, 0));
  if (Math.abs(dr - cr) > 0.001) {
    throw new Error(`Journal entry does not balance: debits ${dr} vs credits ${cr}`);
  }
  return clean;
}

// ---- Entries for each event (pure) ------------------------------------------

export function saleEntry(i: { total: number; netSales: number; tax: number; cogs: number }) {
  return balanced([
    { account: ACC.AR, debit: i.total },
    { account: ACC.SALES, credit: i.netSales },
    { account: ACC.SALES_TAX_PAYABLE, credit: i.tax },
    { account: ACC.COGS, debit: i.cogs },
    { account: ACC.INVENTORY, credit: i.cogs },
  ]);
}

export function customerPaymentEntry(i: { cash: number; discount: number; method: string }) {
  return balanced([
    { account: cashAccountFor(i.method), debit: i.cash },
    { account: ACC.SALES_DISCOUNTS, debit: i.discount },
    { account: ACC.AR, credit: i.cash + i.discount },
  ]);
}

export function customerLateFeeEntry(amount: number) {
  return balanced([
    { account: ACC.AR, debit: amount },
    { account: ACC.LATE_FEE_INCOME, credit: amount },
  ]);
}

export function writeOffEntry(amount: number) {
  return balanced([
    { account: ACC.BAD_DEBT, debit: amount },
    { account: ACC.AR, credit: amount },
  ]);
}

export function billEntry(i: { debitAccount: string; amount: number; freight: number; tax: number }) {
  // Freight and tax on stock purchases are part of the inventory cost.
  const total = i.amount + i.freight + i.tax;
  return balanced([
    { account: i.debitAccount, debit: total },
    { account: ACC.AP, credit: total },
  ]);
}

export function supplierPaymentEntry(i: { cash: number; discount: number; method: string }) {
  return balanced([
    { account: ACC.AP, debit: i.cash + i.discount },
    { account: cashAccountFor(i.method), credit: i.cash },
    { account: ACC.PURCHASE_DISCOUNTS, credit: i.discount },
  ]);
}

export function supplierLateFeeEntry(amount: number) {
  return balanced([
    { account: ACC.LATE_FEES_EXPENSE, debit: amount },
    { account: ACC.AP, credit: amount },
  ]);
}

export function inventoryAdjustmentEntry(value: number) {
  // value > 0 = stock added (opening/count up); value < 0 = shrinkage
  return value >= 0
    ? balanced([
        { account: ACC.INVENTORY, debit: value },
        { account: ACC.OPENING_BALANCE_EQUITY, credit: value },
      ])
    : balanced([
        { account: ACC.INVENTORY_SHRINKAGE, debit: -value },
        { account: ACC.INVENTORY, credit: -value },
      ]);
}

export function payrollEntry(i: { gross: number; net: number; employerTaxes: number }) {
  const withheld = i.gross - i.net;
  return balanced([
    { account: ACC.WAGES, debit: i.gross },
    { account: ACC.PAYROLL_TAX_EXPENSE, debit: i.employerTaxes },
    { account: ACC.BANK, credit: i.net },
    { account: ACC.PAYROLL_LIABILITIES, credit: withheld + i.employerTaxes },
  ]);
}

/** Sales returned (voiding an invoice) reverses the sale entry. */
export function reverse(lines: { account: string; debit: number; credit: number }[]) {
  return balanced(lines.map((l) => ({ account: l.account, debit: l.credit, credit: l.debit })));
}
