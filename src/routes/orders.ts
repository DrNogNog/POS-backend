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
// Create a new purchase order (placeholder)
router.post("/create", async (req, res) => {
  try {
    const newOrder = await prisma.order.create({
      data: {
        productId: "TEMP", // placeholder
        name: "TEMP",
        count: 0,
      },
    });
    res.status(200).json({ orderId: newOrder.id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to create order" });
  }
});

// Cancel order only if it exists
router.delete("/cancel/:id", async (req: Request, res: Response) => {
  const { id } = req.params;

  try {
    const order = await prisma.order.findUnique({ where: { id: Number(id) } });
    if (!order) {
      return res.status(200).json({ message: "Order not found, nothing to cancel" });
    }

    await prisma.order.delete({ where: { id: Number(id) } });
    res.status(200).json({ message: "Order cancelled" });
  } catch (err) {
    console.error("Failed to cancel order:", err);
    res.status(500).json({ error: "Failed to cancel order", details: (err as Error).message });
  }
});
router.patch("/:id", async (req, res) => {
  const { id } = req.params;
  const { vendors, description } = req.body;

  try {
    const updatedOrder = await prisma.order.update({
      where: { id: Number(id) },
      data: { vendors, description },
    });
    res.json(updatedOrder);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update order" });
  }
});


export default router;
