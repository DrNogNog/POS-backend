// -----------------------------------------------------------------------------
// History tab writer. Call `logActivity` whenever something meaningful
// happens (created, updated, approved, paid ...). It runs inside the same
// transaction as the change, so history can never disagree with the data.
// -----------------------------------------------------------------------------
import type { Prisma } from "@prisma/client";
import type { Tx } from "../db/stores.js";

export interface ActivityInput {
  entityType: string;
  entityId?: number | null;
  entityRef?: string;
  action: string;
  summary: string;
  details?: Prisma.InputJsonValue;
  amount?: number | null;
  userName?: string;
}

export async function logActivity(tx: Tx, a: ActivityInput) {
  await tx.activityLog.create({
    data: {
      entityType: a.entityType,
      entityId: a.entityId ?? null,
      entityRef: a.entityRef ?? "",
      action: a.action,
      summary: a.summary,
      details: a.details,
      amount: a.amount ?? null,
      userName: a.userName ?? "",
    },
  });
}

/** List only the fields whose values changed, for UPDATE history entries. */
export function diffFields(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  ignore: string[] = ["updatedAt", "createdAt"]
): Record<string, { from: unknown; to: unknown }> {
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const key of Object.keys(after)) {
    if (ignore.includes(key)) continue;
    const a = JSON.stringify(before[key] ?? null);
    const b = JSON.stringify(after[key] ?? null);
    if (a !== b) changes[key] = { from: before[key] ?? null, to: after[key] ?? null };
  }
  return changes;
}
