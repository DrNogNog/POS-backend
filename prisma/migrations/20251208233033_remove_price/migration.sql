-- CreateTable
CREATE TABLE "User" (
    "id" SERIAL NOT NULL,
    "email" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "name" TEXT,
    "role" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Product" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "inputcost" DECIMAL(10,2) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "images" TEXT[],
    "stock" INTEGER NOT NULL,
    "vendors" TEXT[],
    "needToOrder" INTEGER NOT NULL DEFAULT 0,
    "billing" BOOLEAN,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingPDF" (
    "id" SERIAL NOT NULL,
    "orderId" INTEGER NOT NULL,
    "invoiceNo" TEXT NOT NULL,
    "cost" INTEGER NOT NULL,
    "pdf" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BillingPDF_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Estimate" (
    "id" SERIAL NOT NULL,
    "estimateNo" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "billTo" TEXT NOT NULL,
    "shipTo" TEXT NOT NULL,
    "subtotal" DOUBLE PRECISION NOT NULL,
    "discount" DOUBLE PRECISION NOT NULL,
    "total" DOUBLE PRECISION NOT NULL,
    "pdfData" BYTEA NOT NULL,
    "approved" BOOLEAN NOT NULL DEFAULT false,
    "invoiced" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" INTEGER,
    "companyName" TEXT,
    "companyAddr1" TEXT,
    "companyAddr2" TEXT,
    "phone" TEXT,
    "fax" TEXT,
    "email" TEXT,
    "website" TEXT,
    "items" JSONB,

    CONSTRAINT "Estimate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invoice" (
    "id" SERIAL NOT NULL,
    "invoiceNo" TEXT NOT NULL,
    "total" DECIMAL(10,2) NOT NULL,
    "pdf" BYTEA,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL,

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductChangeLog" (
    "id" SERIAL NOT NULL,
    "productId" INTEGER NOT NULL,
    "action" TEXT NOT NULL,
    "changes" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductChangeLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Archive" (
    "id" SERIAL NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" INTEGER NOT NULL,
    "data" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Archive_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "BillingPDF_invoiceNo_key" ON "BillingPDF"("invoiceNo");

-- CreateIndex
CREATE UNIQUE INDEX "Estimate_estimateNo_key" ON "Estimate"("estimateNo");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_invoiceNo_key" ON "Invoice"("invoiceNo");

-- AddForeignKey
ALTER TABLE "ProductChangeLog" ADD CONSTRAINT "ProductChangeLog_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
