import { Router } from "express";
import type { Request, Response } from "express";
import { PrismaClient } from "@prisma/client";

const router = Router();
const prisma = new PrismaClient();

// POST /api/orders — create a new order with valid productId
router.post("/", async (req: Request, res: Response) => {
  try {
    const { productId, name, description, vendors, count } = req.body;

    if (!productId || !name || !count) {
      return res.status(400).json({ error: "productId, name, and count are required" });
    }

    // Ensure count is a number
    const numericCount = Number(count);
    if (isNaN(numericCount) || numericCount <= 0) {
      return res.status(400).json({ error: "count must be a positive number" });
    }

    const order = await prisma.order.create({
      data: {
        productId: String(productId), // ensure type matches DB
        name,
        description: description || "",
        vendors: Array.isArray(vendors) ? vendors.join(",") : vendors || "",
        count: numericCount,
      },
    });

    res.status(201).json(order);
  } catch (err) {
    console.error("Failed to create order:", err);
    res.status(500).json({ error: "Failed to create order" });
  }
});

// GET /api/orders — include SKU manually
router.get("/", async (req: Request, res: Response) => {
  try {
    const orders = await prisma.order.findMany();

    // map productId to SKU
    const products = await prisma.product.findMany();
    const productMap = Object.fromEntries(products.map((p) => [String(p.id), p.sku || ""]));

    const formattedOrders = orders.map((o) => ({
      id: o.id,
      sku: productMap[o.productId] || "",
      name: o.name,
      description: o.description,
      vendors: o.vendors,
      count: o.count,
      createdAt: o.createdAt,
    }));

    res.json(formattedOrders);
  } catch (err) {
    console.error("Failed to fetch orders:", err);
    res.status(500).json({ error: "Failed to load orders" });
  }
});

// POST /api/orders/create — placeholder for a new order (returns orderId)
router.post("/create", async (req: Request, res: Response) => {
  try {
    const newOrder = await prisma.order.create({
      data: {
        productId: "TEMP",
        name: "TEMP",
        count: 0,
      },
    });
    res.status(200).json({ orderId: newOrder.id });
  } catch (err) {
    console.error("Failed to create placeholder order:", err);
    res.status(500).json({ error: "Failed to create order" });
  }
});

export default router;
