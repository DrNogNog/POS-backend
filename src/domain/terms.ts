// -----------------------------------------------------------------------------
// Payment terms, balances, early-payment discounts, late fees and aging.
// Shared by customer invoices (A/R) and supplier bills (A/P).
//
// Vocabulary
//   Terms "2/10 net 30" = 2% discount if paid within 10 days, otherwise the
//   full amount is due in 30 days.
//   Balance due = total + late fees - paid - discounts taken - written off
// -----------------------------------------------------------------------------
import { addDays, daysBetween } from "../lib/dates.js";
import { percentOf, round2 } from "../lib/money.js";

export interface OpenItem {
  issueDate: Date;
  dueDate: Date;
  total: number;
  amountPaid: number;
  discountsTaken: number;
  lateFees: number;
  writtenOff?: number;
  earlyPayDiscountPct: number;
  earlyPayDiscountDays: number;
}

export function dueDateFor(issueDate: Date, termsDays: number): Date {
  return addDays(issueDate, Math.max(0, termsDays));
}

export function balanceDue(item: Omit<OpenItem, "issueDate" | "dueDate" | "earlyPayDiscountPct" | "earlyPayDiscountDays">): number {
  return round2(
    item.total + item.lateFees - item.amountPaid - item.discountsTaken - (item.writtenOff ?? 0)
  );
}

export function daysPastDue(dueDate: Date, today = new Date()): number {
  return Math.max(0, daysBetween(dueDate, today));
}

/** Is the early-payment discount still available on `onDate`? */
export function earlyDiscountAvailable(item: OpenItem, onDate = new Date()): boolean {
  if (item.earlyPayDiscountPct <= 0 || item.earlyPayDiscountDays <= 0) return false;
  if (item.discountsTaken > 0) return false;
  return daysBetween(item.issueDate, onDate) <= item.earlyPayDiscountDays;
}

/** Last day the early-payment discount can be taken. */
export function earlyDiscountDeadline(item: OpenItem): Date | null {
  if (item.earlyPayDiscountPct <= 0 || item.earlyPayDiscountDays <= 0) return null;
  return addDays(item.issueDate, item.earlyPayDiscountDays);
}

/**
 * Discount earned when paying in full early. The discount is on the original
 * total (before late fees), which is the standard way "2/10 net 30" works.
 */
export function earlyDiscountAmount(item: OpenItem, onDate = new Date()): number {
  if (!earlyDiscountAvailable(item, onDate)) return 0;
  return percentOf(item.total, item.earlyPayDiscountPct);
}

/**
 * Split a payment into cash applied and discount taken.
 * If the payer pays (balance - discount) or more while the discount window is
 * open, the discount is granted and the invoice closes.
 */
export function applyPayment(
  item: OpenItem,
  amount: number,
  onDate = new Date(),
  takeDiscount = true
): { cashApplied: number; discountTaken: number; newBalance: number; overpayment: number } {
  const balance = balanceDue(item);
  let discount = 0;
  if (takeDiscount) {
    const possible = earlyDiscountAmount(item, onDate);
    if (possible > 0 && amount + 0.004 >= round2(balance - possible)) discount = possible;
  }
  const maxCash = round2(balance - discount);
  const cashApplied = round2(Math.min(amount, maxCash));
  const overpayment = round2(Math.max(0, amount - maxCash));
  return {
    cashApplied,
    discountTaken: discount,
    newBalance: round2(balance - discount - cashApplied),
    overpayment,
  };
}

/** Late fee = flat fee + % of the open balance. */
export function lateFeeAmount(balance: number, pct: number, flat: number): number {
  if (balance <= 0) return 0;
  return round2(percentOf(balance, pct) + flat);
}

export type PayStatus = "OPEN" | "PARTIAL" | "PAID" | "VOID";

export function statusFor(item: Parameters<typeof balanceDue>[0], isVoid = false): PayStatus {
  if (isVoid) return "VOID";
  const balance = balanceDue(item);
  if (balance <= 0.004) return "PAID";
  if (item.amountPaid > 0 || item.discountsTaken > 0) return "PARTIAL";
  return "OPEN";
}

// ---- Aging -----------------------------------------------------------------

export const AGING_BUCKETS = ["current", "1-30", "31-60", "61-90", "90+"] as const;
export type AgingBucket = (typeof AGING_BUCKETS)[number];

export function agingBucket(dueDate: Date, today = new Date()): AgingBucket {
  const late = daysBetween(dueDate, today);
  if (late <= 0) return "current";
  if (late <= 30) return "1-30";
  if (late <= 60) return "31-60";
  if (late <= 90) return "61-90";
  return "90+";
}

export function agingSummary(
  items: { dueDate: Date; balance: number }[],
  today = new Date()
): Record<AgingBucket, number> & { total: number } {
  const out = { current: 0, "1-30": 0, "31-60": 0, "61-90": 0, "90+": 0, total: 0 };
  for (const it of items) {
    if (it.balance <= 0) continue;
    const b = agingBucket(it.dueDate, today);
    out[b] = round2(out[b] + it.balance);
    out.total = round2(out.total + it.balance);
  }
  return out;
}
