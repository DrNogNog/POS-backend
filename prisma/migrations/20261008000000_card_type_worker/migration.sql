-- Worker logins: can create estimates and see the approvals list only.
ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'WORKER';

-- Credit or debit, recorded on estimates (approvals) and invoices.
CREATE TYPE "CardType" AS ENUM ('CREDIT', 'DEBIT');
ALTER TABLE "Estimate" ADD COLUMN "cardType" "CardType";
ALTER TABLE "Invoice" ADD COLUMN "cardType" "CardType";

-- Fill in existing invoices from their first credit/debit payment.
UPDATE "Invoice" AS i
SET "cardType" = p.method::text::"CardType"
FROM (
  SELECT DISTINCT ON ("invoiceId") "invoiceId", "method"
  FROM "CustomerPayment"
  WHERE "method" IN ('CREDIT', 'DEBIT')
  ORDER BY "invoiceId", "date"
) AS p
WHERE p."invoiceId" = i."id" AND i."cardType" IS NULL;
