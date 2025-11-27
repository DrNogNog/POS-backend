import { Router } from 'express';
import type { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';

export type CreateProductRequest = {
  sku: string;
  name: string;
  price: number;
  description?: string | null;
};

export default function(prisma: PrismaClient) {
  const router = Router();

  // GET /products?q=searchTerm
  router.get('/', async (req: Request, res: Response) => {
    try {
      const q = String(req.query.q || '');
      const whereClause = q
        ? { name: { contains: q, mode: 'insensitive' as const } }
        : undefined;

      const products = await prisma.product.findMany({
        ...(whereClause ? { where: whereClause } : {}),
        take: 100
      });

      res.json(products);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'failed to fetch products' });
    }
  });

  // POST /products
  router.post('/', async (req: Request<any, any, CreateProductRequest>, res: Response) => {
    try {
      const { sku, name, price, description } = req.body;

      const product = await prisma.product.create({
        data: {
          sku,
          name,
          price: Number(price), // ensure number
          description: description ?? null
        }
      });

      res.status(201).json(product);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'failed to create product' });
    }
  });

  return router;
}
