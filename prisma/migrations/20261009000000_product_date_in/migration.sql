-- "Date in" for items: when the stock came in, or old inventory from before the POS system.
ALTER TABLE "Product" ADD COLUMN "dateIn" TIMESTAMP(3);
ALTER TABLE "Product" ADD COLUMN "oldInventory" BOOLEAN NOT NULL DEFAULT false;

-- Items already in the system: stock received through a purchase order gets that date,
-- everything else is old inventory (it was here before the POS).
UPDATE "Product" AS p
SET "dateIn" = r.last_in
FROM (
  SELECT "productId", MAX("createdAt") AS last_in
  FROM "InventoryMovement"
  WHERE "type" = 'RECEIVE'
  GROUP BY "productId"
) AS r
WHERE r."productId" = p."id";
UPDATE "Product" SET "oldInventory" = true WHERE "dateIn" IS NULL;
