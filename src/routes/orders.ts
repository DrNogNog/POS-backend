import { Router } from "express";
import type { Request, Response } from "express";
import { PrismaClient } from "@prisma/client";

const router = Router();
const prisma = new PrismaClient();

// POST /api/orders
router.post("/", async (req: Request, res: Response) => {
  try {
    const { productId, name, description, vendors, count } = req.body;

    if (!productId || !name || !count) {
      return res.status(400).json({ error: "productId, name, and count are required" });
    }

    const order = await prisma.order.create({
      data: {
        productId,
        name,
        description: description || "",
        vendors: vendors ? vendors.join ? vendors.join(",") : vendors : "",
        count: Number(count),
      },
    });

    res.status(201).json(order);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to create order" });
  }
});

 
// POST /api/orders
router.post("/", async (req: Request, res: Response) => {
  try {
    const { productId, name, description, vendors, count } = req.body;

    if (!productId || !name || !count) {
      return res.status(400).json({ error: "productId, name, and count are required" });
    }

    const order = await prisma.order.create({
      data: {
        productId,
        name,
        description: description || "",
        vendors: vendors ? vendors.join ? vendors.join(",") : vendors : "",
        count: Number(count),
      },
    });

    res.status(201).json(order);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to create order" });
  }
});

// GET /api/orders
router.get("/", async (req: Request, res: Response) => {
  try {
    const orders = await prisma.order.findMany({ orderBy: { createdAt: "desc" } });
    res.json(orders);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch orders" });
  }
});

 

export default router;
