import { Router } from "express";
import type { Request, Response } from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import { PrismaClient, Prisma } from "@prisma/client";

// -----------------------------
// Logging helper (keeps your original signature)
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
// Utility helpers
// -----------------------------
const toNumberSafe = (v: any, fallback = 0) => {
  if (v === undefined || v === null || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

const normalizeVendors = (vendors: any): string[] => {
  if (!vendors) return [];
  if (Array.isArray(vendors)) return vendors.map((v) => String(v).trim()).filter(Boolean);
  return String(vendors)
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
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
         orderBy: [
          { createdAt: "desc" },
        ],
      });

      res.json(products);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to fetch products" });
    }
  });

  // GET /api/products/needToOrder → returns only products with needToOrder > 0
  router.get("/needToOrder", async (req: Request, res: Response) => {
    try {
      const products = await prisma.product.findMany({
        where: {
          needToOrder: { gt: 0 },
          deletedAt: null,
        },
        select: {
          id: true,
          name: true,
          style: true,
          sku: true,
          inputcost: true,
          price: true,
          stock: true,
          vendors: true,
          images: true,
          needToOrder: true,
        },
        orderBy: { needToOrder: "desc" },
      });

      res.json(products);
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "Failed to fetch needed products" });
    }
  });

  // -----------------------------
  // POST /products
  // -----------------------------
  router.post("/", upload.array("images"), async (req: Request, res: Response) => {
    try {
      const { name, price } = req.body;
      if (!name || !price) return res.status(400).json({ error: "Name and price are required" });

      const files = req.files as Express.Multer.File[] | undefined;
      const images = files?.map((f) => f.filename) || [];
      const product = await prisma.product.create({
        data: {
          name: String(req.body.name || ""),
          style: String(req.body.style || ""),
          price: toNumberSafe(req.body.price, 0),
          inputcost: toNumberSafe(req.body.inputcost, 0),
          sku: String(req.body.sku || ""),
          description: String(req.body.description || ""),
          categories: String(req.body.categories || ""),
          stock: toNumberSafe(req.body.stock, 0),
          vendors: normalizeVendors(req.body.vendors),
          images, // use multer filenames
          needToOrder: toNumberSafe(req.body.needToOrder ?? 0, 0),
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

      const files = req.files as Express.Multer.File[] | undefined;
      const newImages = files?.map((f) => f.filename) || [];

      const oldProduct = await prisma.product.findUnique({ where: { id } });
      if (!oldProduct) return res.status(404).json({ error: "Product not found" });

      // Prepare vendors array (if provided)
      const vendors = req.body.vendors ? normalizeVendors(req.body.vendors) : undefined;

      // Determine final images: if new uploads provided, append to existing
      const finalImages = newImages.length > 0 ? [...(oldProduct.images || []), ...newImages] : undefined;

      const data: Prisma.ProductUpdateInput = {
        name: req.body.name ?? undefined,
        price: req.body.price !== undefined ? toNumberSafe(req.body.price) : undefined,
        style: req.body.style ?? undefined,
        inputcost: req.body.inputcost !== undefined ? toNumberSafe(req.body.inputcost) : undefined,
        sku: req.body.sku ?? undefined,
        description: req.body.description ?? undefined,
        categories: req.body.categories ?? undefined,
        stock: req.body.stock !== undefined ? toNumberSafe(req.body.stock) : undefined,
        vendors: vendors !== undefined ? vendors : undefined,
        images: finalImages !== undefined ? finalImages : undefined,
      };

      // Remove undefined keys from data so prisma doesn't overwrite with null
      Object.keys(data).forEach((k) => (data as any)[k] === undefined && delete (data as any)[k]);

      const updatedProduct = await prisma.product.update({
        where: { id },
        data,
      });

      // compute changes
      const changes: Record<string, any> = {};
      for (const key of Object.keys(updatedProduct)) {
        if ((updatedProduct as any)[key] !== (oldProduct as any)[key]) {
          changes[key] = { old: (oldProduct as any)[key], new: (updatedProduct as any)[key] };
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
  // DELETE /products/:id (soft delete)
  // -----------------------------
  router.delete("/:id", async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });

      const product = await prisma.product.findUnique({ where: { id } });
      if (!product) return res.status(404).json({ error: "Product not found" });

      await prisma.product.update({
        where: { id },
        data: { deletedAt: new Date() },
      });

      await logProductChange(product.id, "DELETE", {});

      res.json({ message: "Product marked as deleted" });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to delete product" });
    }
  });

  // -----------------------------
  // PATCH /products/decrement-stock
  // -----------------------------
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

        if ((product.stock || 0) < qty) {
          return res
            .status(400)
            .json({ error: `Insufficient stock for "${product.sku || product.name}"` });
        }

        await prisma.product.update({
          where: { id: product.id },
          data: { stock: (product.stock || 0) - qty },
        });
      }

      res.json({ message: "Stock decremented successfully" });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to decrement product stock" });
    }
  });

  // -----------------------------
  // PATCH /products/increment-stock
  // -----------------------------
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

  // -----------------------------
  // PATCH /products/increment-stock-by-style-sku
  // -----------------------------
  router.patch("/increment-stock-by-style-sku", async (req: Request, res: Response) => {
    const { items } = req.body;

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "No items provided" });
    }

    try {
      for (const { style, sku, qty } of items) {
        if (!style || !sku) {
          return res.status(400).json({ error: "Missing style or sku in an item" });
        }

        const product = await prisma.product.findFirst({
          where: {
            style: String(style).trim(),
            sku: String(sku).trim(),
          },
        });

        if (!product) {
          return res.status(404).json({ error: `Product not found: ${style} / ${sku}` });
        }

        await prisma.product.update({
          where: { id: product.id },
          data: { stock: (product.stock || 0) + Number(qty || 0) },
        });
      }

      res.json({ message: "Stock updated by style + SKU" });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to update stock" });
    }
  });

  // -----------------------------
  // POST /api/products/stock
  // -----------------------------
  router.post("/stock", async (req: Request, res: Response) => {
    try {
      const { productIds } = req.body;
      if (!Array.isArray(productIds)) return res.status(400).json({ error: "Invalid productIds" });

      const products = await prisma.product.findMany({
        where: { id: { in: productIds } },
        select: { id: true, name: true, stock: true },
      });

      res.json(products);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to fetch product stock" });
    }
  });

  // -----------------------------
  // PATCH /api/products/needToOrder/:id
  // -----------------------------
  router.patch("/needToOrder/:id", async (req: Request, res: Response) => {
    const id = Number(req.params.id);

    if (!id || isNaN(id)) {
      return res.status(400).json({ error: "Invalid product ID" });
    }

    const { needToOrder } = req.body;

    if (
      typeof needToOrder !== "number" ||
      needToOrder < 0 ||
      !Number.isInteger(needToOrder)
    ) {
      return res.status(400).json({ error: "needToOrder must be a positive integer" });
    }

    try {
      const updated = await prisma.product.update({
        where: { id },
        data: { needToOrder },
        select: { id: true, name: true, needToOrder: true },
      });

      return res.json({ success: true, product: updated });
    } catch (error: any) {
      console.error("PATCH failed:", error);

      if (error.code === "P2025") {
        return res.status(404).json({ error: "Product not found" });
      }

      return res.status(500).json({ error: "Database error" });
    }
  });

  // -----------------------------
  // PATCH /products/billing/:id
  // -----------------------------
  router.patch("/billing/:id", async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });

      const { billing } = req.body;
      await prisma.product.update({
        where: { id },
        data: { billing },
      });
      return res.json({ success: true });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to update billing" });
    }
  });

  return router;
}
