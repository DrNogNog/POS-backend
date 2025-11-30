import { Router } from "express";
import type { Request, Response } from "express";
import { PrismaClient, Prisma } from "@prisma/client";
import multer from "multer";
import path from "path";
import fs from "fs";

export default function (prisma: PrismaClient) {
  const router = Router();

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
      const name = path.basename(file.originalname, ext)
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
    limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
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
            { name: { contains: q, mode: "insensitive" } },
            { sku: { contains: q, mode: "insensitive" } },
            { categories: { contains: q, mode: "insensitive" } },
            { vendors: { has: q } }, // assuming vendors is string[]
          ],
        };
      }

      const products = await prisma.product.findMany({
        where,
        take: 100,
      });

      res.json(products);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to fetch products" });
    }
  });

  // -----------------------------
  // POST /products — create product
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
          stockCounts: stockCounts ? Number(stockCounts) : 0,
          vendors: vendors ? vendors.split(",").map((v) => v.trim()) : [],
          images,
        },
      });

      res.json(product);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to create product" });
    }
  });

  // -----------------------------
  // PUT /products/:id — update product
  // -----------------------------
  router.put("/:id", upload.array("images"), async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });

      const { name, price, description, sku, categories, stock, stockCounts, vendors } = req.body;
      const files = req.files as Express.Multer.File[] | undefined;
      const images = files?.map((f) => f.filename);

      const updatedProduct = await prisma.product.update({
        where: { id },
        data: {
          name,
          price: price ? parseFloat(price) : undefined,
          description,
          sku,
          categories,
          stock: stock ? Number(stock) : undefined,
          stockCounts: stockCounts ? Number(stockCounts) : undefined,
          vendors: vendors ? vendors.split(",").map((v) => v.trim()) : undefined,
          images: images?.length ? images : undefined,
        },
      });

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
    try {
      const id = Number(req.params.id);
      if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });

      const product = await prisma.product.delete({ where: { id } });

      // Remove uploaded files
      if (product.images?.length) {
        for (const filename of product.images) {
          const filePath = path.join(uploadDir, filename);
          if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        }
      }

      res.json({ message: "Deleted" });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to delete product" });
    }
  });

  return router;
}
