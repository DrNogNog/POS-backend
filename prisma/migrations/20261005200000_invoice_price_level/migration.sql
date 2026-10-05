-- Remember which price level (AA, A, B, C, D) each invoice was priced at,
-- so the costing screen can show margins per invoice and per level.
ALTER TABLE "Invoice" ADD COLUMN "priceTierCode" TEXT NOT NULL DEFAULT '';
