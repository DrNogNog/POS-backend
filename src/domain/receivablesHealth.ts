// -----------------------------------------------------------------------------
// A/R health board logic.
//
// Days Sales Outstanding (DSO) = A/R balance ÷ sales in the period × days.
// It answers: "on average, how many days does it take us to get paid?"
//
//   DSO too HIGH  -> customers are slow to pay; cash is tied up; risk of bad
//                    debt. Tighten terms, send reminders, charge late fees.
//   DSO too LOW   -> almost nobody is buying on account. Could mean terms are
//                    too rigid and we're losing contractor business.
//   In between    -> healthy.
// -----------------------------------------------------------------------------
import { round2 } from "../lib/money.js";

export interface HealthInput {
  arBalance: number;
  overdueBalance: number;
  /** Total sales (all invoices) in the look-back period. */
  salesInPeriod: number;
  /** Sales made on account (terms > 0) in the period. */
  creditSalesInPeriod: number;
  periodDays: number;
  highDso: number;
  lowDso: number;
}

export type HealthLevel = "HIGH" | "HEALTHY" | "LOW" | "NO_DATA";

export interface HealthResult {
  dso: number;
  overduePct: number;
  creditSalesPct: number;
  /** A/R turnover per year: how many times A/R is collected in a year. */
  turnover: number;
  level: HealthLevel;
  headline: string;
  advice: string[];
}

export function receivablesHealth(i: HealthInput): HealthResult {
  const dso = i.salesInPeriod > 0 ? round2((i.arBalance / i.salesInPeriod) * i.periodDays) : 0;
  const overduePct = i.arBalance > 0 ? round2((i.overdueBalance / i.arBalance) * 100) : 0;
  const creditSalesPct =
    i.salesInPeriod > 0 ? round2((i.creditSalesInPeriod / i.salesInPeriod) * 100) : 0;
  const annualSales = i.periodDays > 0 ? (i.salesInPeriod / i.periodDays) * 365 : 0;
  const turnover = i.arBalance > 0 ? round2(annualSales / i.arBalance) : 0;

  if (i.salesInPeriod <= 0 && i.arBalance <= 0) {
    return {
      dso,
      overduePct,
      creditSalesPct,
      turnover,
      level: "NO_DATA",
      headline: "Not enough sales yet to judge A/R.",
      advice: ["Once invoices are created, this board will rate your receivables."],
    };
  }

  const advice: string[] = [];
  let level: HealthLevel = "HEALTHY";
  let headline = `Healthy — customers pay in about ${Math.round(dso)} days on average.`;

  if (dso > i.highDso || overduePct > 30) {
    level = "HIGH";
    headline = `A/R is too high — it takes about ${Math.round(dso)} days to get paid.`;
    advice.push("Call or email customers on the 31–60 and 61–90 day lists.");
    advice.push("Charge late fees on invoices past due.");
    advice.push("Offer an early-payment discount (e.g. 2/10 net 30) to speed up cash.");
    if (overduePct > 30) advice.push(`${Math.round(overduePct)}% of A/R is overdue — consider collections for 90+ days.`);
    advice.push("Lower credit limits or shorten terms for slow payers.");
  } else if (dso < i.lowDso && creditSalesPct < 10) {
    level = "LOW";
    headline = "A/R is very low — almost all sales are cash. Terms may be too rigid.";
    advice.push("Consider offering 30-day terms to reliable contractors to win larger orders.");
    advice.push("Set credit limits per customer so risk stays controlled.");
  } else {
    advice.push("Keep sending statements and following up on anything past due.");
  }

  return { dso, overduePct, creditSalesPct, turnover, level, headline, advice };
}
