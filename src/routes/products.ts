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

  // Ensure uploads folder exists
  const uploadDir = path.join(process.cwd(), "uploads");
  if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

  // Multer storage config
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

  // GET /products?q=search
  router.get("/", async (req: Request, res: Response) => {
  try {
    const q = String(req.query.q || "").trim();

    // Parse page & limit from query params
    const page = parseInt(String(req.query.page || "1"), 10);
    const limit = parseInt(String(req.query.limit || "100"), 10);
    const skip = (page - 1) * limit;

    let where: Prisma.ProductWhereInput | undefined = undefined;

    if (q) {
      where = {
        OR: [
          { name: { contains: q, mode: "insensitive" } as Prisma.StringFilter },
          { vendors: { has: q } },
        ],
      };
    }

    // Fetch products with pagination
    const [products, totalCount] = await Promise.all([
      prisma.product.findMany({
        where: { ...where, deletedAt: null },
        take: limit,
        skip,
        orderBy: [{ createdAt: "desc" }],
      }),
      prisma.product.count({ where: { ...where, deletedAt: null } }),
    ]);

    res.json({
      products,
      total: totalCount,
      page,
      totalPages: Math.ceil(totalCount / limit),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch products" });
  }
});

  // GET /products/needToOrder
  router.get("/needToOrder", async (req: Request, res: Response) => {
    try {
      const products = await prisma.product.findMany({
        where: { needToOrder: { gt: 0 }, deletedAt: null },
        select: {
          id: true,
          name: true,
          description: true,
          inputcost: true,
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

  // POST /products
  router.post("/", upload.array("images"), async (req: Request, res: Response) => {
    try {
      const { name } = req.body;
      if (!name) return res.status(400).json({ error: "Name is required" });

      const files = req.files as Express.Multer.File[] | undefined;
      const images = files?.map((f) => f.filename) || [];
      const product = await prisma.product.create({
        data: {
          name: String(req.body.name || ""),
          inputcost: toNumberSafe(req.body.inputcost, 0),
          description: String(req.body.description || ""),
          stock: toNumberSafe(req.body.stock, 0),
          vendors: normalizeVendors(req.body.vendors),
          images,
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

  // POST /products/duplicate
  router.post("/duplicate", async (req: Request, res: Response) => {
    try {
      const data = req.body;
      const product = await prisma.product.create({
        data: {
          name: String(data.name || ""),
          inputcost: toNumberSafe(data.inputcost, 0),
          description: String(data.description || ""),
          stock: toNumberSafe(data.stock, 0),
          vendors: normalizeVendors(data.vendors),
          images: data.images || [],
          needToOrder: 0,
        },
      });

      await logProductChange(product.id, "CREATE OR DUPLICATE", { ...product });
      res.json(product);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to duplicate product" });
    }
  });

  // PUT /products/:id
  function normalizeArrayField(value: any): string[] | undefined {
    if (!value) return undefined;
    if (Array.isArray(value)) return value;
    return value.split(",").map((s: string) => s.trim());
  }

  router.put("/:id", upload.array("images"), async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });

      const files = req.files as Express.Multer.File[] | undefined;
      const uploadedImages = files?.map((f) => f.filename) || [];

      const oldProduct = await prisma.product.findUnique({ where: { id } });
      if (!oldProduct) return res.status(404).json({ error: "Product not found" });

      const finalImages =
        uploadedImages.length > 0 ? [...(oldProduct.images || []), ...uploadedImages] : undefined;

      let data: Prisma.ProductUpdateInput = {
        name: req.body.name ?? undefined,
        description: req.body.description ?? undefined,
        inputcost: req.body.inputcost !== undefined ? toNumberSafe(req.body.inputcost) : undefined,
        stock: req.body.stock !== undefined ? toNumberSafe(req.body.stock) : undefined,
        vendors: normalizeArrayField(req.body.vendors),
        images: finalImages,
      };

      Object.keys(data).forEach((k) => {
        if ((data as any)[k] === undefined) delete (data as any)[k];
      });

      const updatedProduct = await prisma.product.update({ where: { id }, data });

      const changes: Record<string, any> = {};
      for (const key of Object.keys(updatedProduct)) {
        if ((updatedProduct as any)[key] !== (oldProduct as any)[key]) {
          changes[key] = { old: (oldProduct as any)[key], new: (updatedProduct as any)[key] };
        }
      }

      await logProductChange(id, "UPDATE", changes);
      return res.json(updatedProduct);
    } catch (err) {
      console.error("Update Error:", err);
      return res.status(500).json({ error: "Failed to update product" });
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
  const items = req.body.items;
  if (!Array.isArray(items) || items.length === 0)
    return res.status(400).json({ error: "No items provided" });

  try {
    const results = [];
    for (const { name, quantity } of items) {
      if (!name || !quantity) continue;

      const product = await prisma.product.findFirst({
        where: { 
          name: name.trim(),    // ← EXACT MATCH + TRIM (this works on SQLite)
          deletedAt: null 
        },
      });

      if (!product) {
        console.log(`Product not found: "${name}"`);
        continue;
      }

      if (product.stock < quantity) {
        return res.status(400).json({ 
          error: `Not enough stock for ${name}. Available: ${product.stock}, Requested: ${quantity}` 
        });
      }

      const updated = await prisma.product.update({
        where: { id: product.id },
        data: { stock: { decrement: quantity } },
      });

      results.push(updated);
    }

    if (results.length === 0) {
      return res.status(400).json({ error: "No products were updated (not found or no stock)" });
    }

    res.json({ success: true, updated: results });
  } catch (err: any) {
    console.error("Decrement stock error:", err);
    res.status(500).json({ error: err.message || "Stock update failed" });
  }
});

  // -----------------------------
  // PATCH /products/increment-stock
  // -----------------------------
  router.patch("/increment-stock", async (req: Request, res: Response) => {
    const { items } = req.body;

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "No items provided" });
    }

    try {
      for (const { item, qty } of items) {
        if (!item) {
          return res.status(400).json({ error: "Missing product name (item)" });
        }

        const product = await prisma.product.findFirst({
          where: { name: String(item).trim() },
        });

        if (!product) {
          return res.status(404).json({ error: `Product not found: ${item}` });
        }

        await prisma.product.update({
          where: { id: product.id },
          data: { stock: (product.stock || 0) + Number(qty || 0) },
        });
      }

      res.json({ message: "Stock incremented successfully" });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to increment product stock" });
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
  router.patch("/updateImage", upload.single("newImage"), async (req, res) => {
  const { oldFilename } = req.body;
  const file = req.file;

  if (!oldFilename || !file) return res.status(400).json({ error: "Old filename or new image missing" });

  try {
    // Find product containing this image
    const product = await prisma.product.findFirst({ where: { images: { has: oldFilename } } });
    if (!product) return res.status(404).json({ error: "Product/image not found" });

    // Replace old filename in images array
    const updatedImages = product.images.map((img) => (img === oldFilename ? file.filename : img));

    await prisma.product.update({
      where: { id: product.id },
      data: { images: updatedImages },
    });

    // Optionally delete old image from disk
    const oldPath = path.join(process.cwd(), "uploads", oldFilename);
    if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);

    res.json({ src: `http://localhost:4000/uploads/${file.filename}` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update image" });
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
