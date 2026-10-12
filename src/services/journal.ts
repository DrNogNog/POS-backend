// -----------------------------------------------------------------------------
// Writes double-entry journal entries to the database.
// The entry lines come from the pure functions in domain/accounts.ts.
// -----------------------------------------------------------------------------
import type { Tx } from "../db/stores.js";
import { CHART_OF_ACCOUNTS } from "../domain/accounts.js";

/**
 * Makes sure every account in the chart exists in this database. Databases set
 * up before an account was added (or never seeded) would otherwise reject the
 * entry with "Foreign key constraint violated ... JournalLine_accountCode_fkey".
 * Runs at server start and, as a safety net, before an entry uses a missing code.
 */
export async function ensureChartOfAccounts(db: Tx, codes?: string[]) {
  const wanted = codes ? CHART_OF_ACCOUNTS.filter((a) => codes.includes(a.code)) : CHART_OF_ACCOUNTS;
  if (!wanted.length) return 0;
  const have = new Set(
    (await db.account.findMany({ where: { code: { in: wanted.map((a) => a.code) } }, select: { code: true } })).map((a) => a.code)
  );
  const missing = wanted.filter((a) => !have.has(a.code));
  if (missing.length) {
    await db.account.createMany({
      data: missing.map((a) => ({ code: a.code, name: a.name, type: a.type, isCurrent: a.isCurrent ?? true })),
      skipDuplicates: true,
    });
  }
  return missing.length;
}

export async function postEntry(
  tx: Tx,
  entry: {
    date?: Date;
    memo: string;
    sourceType: string;
    sourceRef?: string;
    userName?: string;
    lines: { account: string; debit: number; credit: number }[];
  }
) {
  if (entry.lines.length === 0) return null;
  await ensureChartOfAccounts(tx, [...new Set(entry.lines.map((l) => l.account))]);
  return tx.journalEntry.create({
    data: {
      date: entry.date ?? new Date(),
      memo: entry.memo,
      sourceType: entry.sourceType,
      sourceRef: entry.sourceRef ?? "",
      createdBy: entry.userName ?? "",
      lines: {
        create: entry.lines.map((l) => ({
          accountCode: l.account,
          debit: l.debit,
          credit: l.credit,
        })),
      },
    },
  });
}
