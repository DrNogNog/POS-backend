// -----------------------------------------------------------------------------
// Payroll math.
//
// We calculate GROSS pay here. Tax withholdings (federal, state, Social
// Security, Medicare) are ENTERED from your payroll provider or the IRS/state
// tables — tax rules change every year and are best left to a payroll service.
// -----------------------------------------------------------------------------
import { round2 } from "../lib/money.js";

export const PERIODS_PER_YEAR = {
  WEEKLY: 52,
  BIWEEKLY: 26,
  SEMIMONTHLY: 24,
  MONTHLY: 12,
} as const;

export type Frequency = keyof typeof PERIODS_PER_YEAR;

export interface GrossInput {
  payType: "HOURLY" | "SALARY";
  payRate: number; // hourly rate, or annual salary
  payFrequency: Frequency;
  regularHours: number;
  overtimeHours: number;
  overtimeMultiplier?: number; // 1.5 = time and a half
}

export function grossPay(i: GrossInput): number {
  if (i.payType === "SALARY") {
    return round2(i.payRate / PERIODS_PER_YEAR[i.payFrequency]);
  }
  const ot = i.overtimeMultiplier ?? 1.5;
  return round2(i.regularHours * i.payRate + i.overtimeHours * i.payRate * ot);
}

export interface Withholdings {
  federalTax: number;
  stateTax: number;
  socialSecurity: number;
  medicare: number;
  otherDeductions: number;
}

export function netPay(gross: number, w: Withholdings): number {
  return round2(
    gross - w.federalTax - w.stateTax - w.socialSecurity - w.medicare - w.otherDeductions
  );
}

/**
 * Suggested FICA amounts (employee share) so the screen can pre-fill them.
 * 2026 rates: Social Security 6.2%, Medicare 1.45%. Always confirm with your
 * accountant / payroll provider.
 */
export function suggestedFica(gross: number) {
  return { socialSecurity: round2(gross * 0.062), medicare: round2(gross * 0.0145) };
}
