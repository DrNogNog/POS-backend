// -----------------------------------------------------------------------------
// Writes double-entry journal entries to the database.
// The entry lines come from the pure functions in domain/accounts.ts.
// -----------------------------------------------------------------------------
import type { Tx } from "../db/stores.js";

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
