import { Router } from "express";
import type { Request, Response } from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import { PrismaClient, Prisma } from "@prisma/client";

// -----------------------------
// Logging helper
// -----------------------------
const createLogHelper = (prisma: PrismaClient) => async (
  productId: number,
  action: "CREATE OR DUPLICATE" | "UPDATE" | "DELETE",
  changes?: Record<string, any>
) => {
  try {
    await prisma.productChangeLog.create({
      data: { productId, action, changes },
    });
  } catch (err) {
    console.error("Failed to log product change:", err);
  }
};

// -----------------------------
// Products router
// -----------------------------
export default function productsRoutes(prisma: PrismaClient) {
  const router = Router();
  const logProductChange = createLogHelper(prisma);

  // -----------------------------
  // Ensure uploads folder exists
  // -----------------------------
  const uploadDir = path.join(process.cwd(), "uploads");
  if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

  // -----------------------------
  // Multer storage config
  // -----------------------------
  const storage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadDir),
    filename: (_req, file, cb) => {
      const timestamp = Date.now();
      const ext = path.extname(file.originalname);
      const name = path
        .basename(file.originalname, ext)
        .replace(/\s+/g, "_")
        .replace(/[^a-zA-Z0-9_-]/g, "");
      cb(null, `${timestamp}-${name}${ext}`);
    },
  });

  const upload = multer({
    storage,
    fileFilter: (_req, file, cb) => {
      const allowed = ["image/png", "image/jpeg", "image/jpg", "image/webp"];
      if (allowed.includes(file.mimetype)) cb(null, true);
      else cb(new Error("Invalid file type"));
    },
    limits: { fileSize: 5 * 1024 * 1024 },
  });

  // -----------------------------
  // GET /products?q=search
  // -----------------------------
  router.get("/", async (req: Request, res: Response) => {
    try {
      const q = String(req.query.q || "").trim();
      let where: Prisma.ProductWhereInput | undefined = undefined;

      if (q) {
        where = {
          OR: [
            { name: { contains: q, mode: "insensitive" } as Prisma.StringFilter },
            { sku: { contains: q, mode: "insensitive" } as Prisma.StringFilter },
            { categories: { contains: q, mode: "insensitive" } as Prisma.StringFilter },
            { vendors: { has: q } },
          ],
        };
      }

      const products = await prisma.product.findMany({
        where: { ...where, deletedAt: null },
        take: 100,
      });

      res.json(products);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to fetch products" });
    }
  });

  // -----------------------------
  // POST /products
  // -----------------------------
  router.post("/", upload.array("images"), async (req: Request, res: Response) => {
    try {
      const { name, price, description, sku, categories, stock, stockCounts, vendors } = req.body;
      if (!name || !price) return res.status(400).json({ error: "Name and price are required" });

      const files = req.files as Express.Multer.File[] | undefined;
      const images = files?.map((f) => f.filename) || [];

      const product = await prisma.product.create({
        data: {
          name,
          price: parseFloat(price),
          description: description || "",
          sku: sku || "",
          categories: categories || "",
          stock: stock ? Number(stock) : 0,
          vendors: vendors
            ? (vendors as string).split(",").map((v: string) => v.trim())
            : [],
          images,
        },
      });

      await logProductChange(product.id, "CREATE OR DUPLICATE", { ...product });

      res.json(product);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to create product" });
    }
  });

  // -----------------------------
  // PUT /products/:id
  // -----------------------------
  router.put("/:id", upload.array("images"), async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });

      const { name, price, description, sku, categories, stock, stockCounts, vendors } = req.body;
      const files = req.files as Express.Multer.File[] | undefined;
      const images = files?.map((f) => f.filename);

      const oldProduct = await prisma.product.findUnique({ where: { id } });

      const updatedProduct = await prisma.product.update({
        where: { id },
        data: {
          name,
          price: price ? parseFloat(price) : undefined,
          description,
          sku,
          categories,
          stock: stock ? Number(stock) : undefined,
          vendors: vendors
            ? (vendors as string).split(",").map((v: string) => v.trim())
            : [],
          images: images?.length ? images : undefined,
        },
      });

      const changes: Record<string, any> = {};
      if (oldProduct) {
        for (const key of Object.keys(updatedProduct)) {
          if ((updatedProduct as any)[key] !== (oldProduct as any)[key]) {
            changes[key] = { old: (oldProduct as any)[key], new: (updatedProduct as any)[key] };
          }
        }
      }

      await logProductChange(updatedProduct.id, "UPDATE", changes);

      res.json(updatedProduct);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to update product" });
    }
  });

  // -----------------------------
  // DELETE /products/:id
  // -----------------------------
 router.delete("/:id", async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });

  const product = await prisma.product.findUnique({ where: { id } });
  if (!product) return res.status(404).json({ error: "Product not found" });

  await prisma.product.update({
    where: { id },
    data: { deletedAt: new Date() }, // soft delete
  });

  res.json({ message: "Product marked as deleted" });
});

router.patch("/decrement-stock", async (req: Request, res: Response) => {
  const { items } = req.body;

  if (!Array.isArray(items) || items.length === 0)
    return res.status(400).json({ error: "No items provided" });

  try {
    for (const { sku, qty } of items) {
      const product = await prisma.product.findFirst({
        where: { sku },
      });

      if (!product) {
        return res.status(404).json({ error: `Product with SKU "${sku}" not found` });
      }

      if (product.stock < qty) {
        return res
          .status(400)
          .json({ error: `Insufficient stock for "${product.sku || product.name}"` });
      }

      await prisma.product.update({
        where: { id: product.id },
        data: { stock: product.stock - qty },
      });
    }

    res.json({ message: "Stock decremented successfully" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to decrement product stock" });
  }
});

// PATCH /products/increment-stock
router.patch("/increment-stock", async (req: Request, res: Response) => {
  const { items } = req.body;

  if (!Array.isArray(items) || items.length === 0)
    return res.status(400).json({ error: "No items provided" });

  try {
    for (const { sku, qty } of items) {
      const product = await prisma.product.findFirst({
        where: { sku },
      });

      if (!product) {
        return res.status(404).json({ error: `Product with SKU "${sku}" not found` });
      }

      await prisma.product.update({
        where: { id: product.id },
        data: { stock: (product.stock || 0) + qty },
      });
    }

    res.json({ message: "Stock incremented successfully" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to increment product stock" });
  }
});







// POST /api/products/stock
router.post("/stock", async (req: Request, res: Response) => {
  const { productIds } = req.body;
  if (!Array.isArray(productIds)) return res.status(400).json({ error: "Invalid productIds" });

  const products = await prisma.product.findMany({
    where: { id: { in: productIds } },
    select: { id: true, name: true, stock: true },
  });

  res.json(products);
});



  return router;
}
