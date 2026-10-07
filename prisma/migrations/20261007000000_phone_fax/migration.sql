-- Separate phone and fax fields for customers, estimates and invoices
-- (printed in their own boxes on the PDFs instead of inside "Bill to").
ALTER TABLE "Customer" ADD COLUMN "fax" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Estimate" ADD COLUMN "phone" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Estimate" ADD COLUMN "fax" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Invoice" ADD COLUMN "phone" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Invoice" ADD COLUMN "fax" TEXT NOT NULL DEFAULT '';
