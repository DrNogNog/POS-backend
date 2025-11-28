import { Router } from "express";
import type { Request, Response } from "express";
import { PrismaClient } from "@prisma/client";
import multer from "multer";
import path from "path";
import fs from "fs";

export default function (prisma: PrismaClient) {
  const router = Router();

  // Ensure uploads folder exists
  const uploadDir = path.join(process.cwd(), "uploads");
  if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

  // Multer disk storage with sanitized filenames
  const storage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadDir),
    filename: (_req, file, cb) => {
      const timestamp = Date.now();
      const ext = path.extname(file.originalname);
      const name = path.basename(file.originalname, ext)
        .replace(/\s+/g, "_") // replace spaces with _
        .replace(/[^a-zA-Z0-9_-]/g, ""); // remove unsafe chars
      const uniqueName = `${timestamp}-${name}${ext}`;
      cb(null, uniqueName);
    },
  });


  const upload = multer({ storage });

  // -----------------------------
  // GET /products?q=searchTerm
  // -----------------------------
  router.get("/", async (req: Request, res: Response) => {
    try {
      const q = String(req.query.q || "");
      const whereClause = q
        ? { name: { contains: q, mode: "insensitive" as const } }
        : undefined;

      const products = await prisma.product.findMany({
        ...(whereClause ? { where: whereClause } : {}),
        take: 100,
      });

      res.json(products);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to fetch products" });
    }
  });

  // -----------------------------
  // POST /products — supports FormData (images)
  // -----------------------------
  router.post("/", upload.array("images"), async (req: Request, res: Response) => {
    try {
      const { name, price, description, sku } = req.body;
      const files = req.files as Express.Multer.File[] | undefined;

      // Save only sanitized filenames in DB
       const images = files?.map((file) => {
        console.log("Saved filename:", file.filename); // <--- check this
        return file.filename;
      }) || [];

      const product = await prisma.product.create({
        data: {
          name,
          price: parseFloat(price),
          description,
          sku,
          images,
        },
      });

      res.json(product);
    } catch (err) {
      console.error(err);
      res.status(500).send("Error creating product");
    }
  });

  // -----------------------------
  // DELETE /products/:id
  // -----------------------------
  router.delete("/:id", async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

      const product = await prisma.product.delete({ where: { id } });

      // Remove uploaded files from disk
      if (product.images?.length) {
        for (const filename of product.images) {
          const filePath = path.join(uploadDir, filename);
          if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        }
      }

      res.status(200).json({ message: "Deleted" });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to delete product" });
    }
  });

  return router;
}
