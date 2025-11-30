import { Router } from "express";
import { PrismaClient } from "@prisma/client";


export function productChangeLogRoutes(prisma: PrismaClient) {
  const router = Router();

  router.get("/", async (_req, res) => {
    try {
      const logs = await prisma.productChangeLog.findMany({
        orderBy: { createdAt: "desc" },
        take: 100,
      });

      // Map createdAt → timestamp
      const mappedLogs = logs.map((log) => ({
        ...log,
        timestamp: log.createdAt,
      }));

      res.json(mappedLogs);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to fetch logs" });
    }
  });

  return router;
}
