import { Router } from 'express';
import type { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { Server as SocketIOServer } from 'socket.io';

export type SaleItemInput = {
  productId: number;
  qty: number;
  price: number;
};

export type PaymentInput = {
  method: string;
  providerRef?: string | null;
};

export type CreateSaleRequest = {
  userId: number;
  customerId?: number | null;
  items: SaleItemInput[];
  payment: PaymentInput;
};

export default function(prisma: PrismaClient, io: SocketIOServer) {
  const router = Router();

  router.post('/', async (req: Request<any, any, CreateSaleRequest>, res: Response) => {
    const { userId, items, customerId, payment } = req.body;

    // Compute totals
    const subtotal = items.reduce((acc, item) => acc + item.qty * item.price, 0);
    const tax = subtotal * 0.07; // example tax
    const total = subtotal + tax;

    try {
      // 1️⃣ Create the sale with items and payment
      const sale = await prisma.sale.create({
        data: {
          userId,
          customerId: customerId ?? null,
          subtotal,
          tax,
          total,
          status: 'completed',
          items: {
            create: items.map((item) => ({
              product: { connect: { id: item.productId } },
              qty: item.qty,
              price: item.price
            }))
          },
          payment: {
            create: {
              method: payment.method,
              amount: total,
              providerRef: payment.providerRef ?? null
            }
          }
        },
        include: { items: true, payment: true } // ensures TS knows sale has items and payment
      });

      // 2️⃣ Update inventory
      for (const item of items) {
        await prisma.inventory.updateMany({
          where: { productId: item.productId },
          data: { quantity: { decrement: item.qty } }
        });
      }

      // 3️⃣ Emit real-time update
      io.emit('sale:created', sale);

      res.status(201).json(sale);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'failed to create sale' });
    }
  });

  return router;
}
