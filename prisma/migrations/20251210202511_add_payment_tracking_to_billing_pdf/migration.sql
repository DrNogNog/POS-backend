/*
  Warnings:

  - You are about to drop the `BillingPDF` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropTable
DROP TABLE "public"."BillingPDF";

-- CreateTable
CREATE TABLE "billing_pdfs" (
    "id" SERIAL NOT NULL,
    "orderId" INTEGER NOT NULL,
    "invoiceNo" TEXT NOT NULL,
    "cost" DECIMAL(10,2) NOT NULL,
    "amountPaid" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "paidAt" TIMESTAMP(3),
    "pdf" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_pdfs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "billing_pdfs_invoiceNo_key" ON "billing_pdfs"("invoiceNo");
