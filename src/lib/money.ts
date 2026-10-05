// -----------------------------------------------------------------------------
// Money helpers.
//
// The database stores money as exact Decimal(12,2). In code we convert to
// numbers and ALWAYS round to cents with `round2` after any multiply/divide,
// so we never get $10.000000001 style errors.
// -----------------------------------------------------------------------------

/** Accepts number | string | Prisma.Decimal | null and returns a number. */
export function num(value: unknown): number {
  if (value === null || value === undefined || value === "") return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const n = Number(String(value));
  return Number.isFinite(n) ? n : 0;
}

/** Round to cents using "round half away from zero" (standard for invoices). */
export function round2(value: number): number {
  const sign = value < 0 ? -1 : 1;
  return (sign * Math.round(Math.abs(value) * 100 + 1e-9)) / 100;
}

/** Round to 4 decimals (unit costs can carry fractions of a cent). */
export function round4(value: number): number {
  const sign = value < 0 ? -1 : 1;
  return (sign * Math.round(Math.abs(value) * 10000 + 1e-9)) / 10000;
}

/** Round a quantity to 3 decimals. */
export function round3(value: number): number {
  const sign = value < 0 ? -1 : 1;
  return (sign * Math.round(Math.abs(value) * 1000 + 1e-9)) / 1000;
}

export function sum(values: number[]): number {
  return round2(values.reduce((a, b) => a + b, 0));
}

/** percent(100, 8.875) => 8.88 */
export function percentOf(amount: number, pct: number): number {
  return round2((amount * pct) / 100);
}

export function formatMoney(value: number): string {
  return value.toLocaleString("en-US", { style: "currency", currency: "USD" });
}
