import { Router } from "express";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const router = Router();

router.post("/", async (req, res) => {
  console.log("Archive request:", req.body);

  try {
    const { entity, entityId, data } = req.body;
    if (!entity || !entityId || !data) {
      return res.status(400).json({ error: "Missing fields" });
    }

    const archive = await prisma.archive.create({
      data: {
        entity,
        entityId: Number(entityId),
        data,
      },
    });

    res.json(archive);
  } catch (err) {
    console.error("Archive error:", err);
    res.status(500).json({ error: "Failed to archive" });
  }
});
// Get all archives
router.get("/", async (_req, res) => {
  try {
    const archives = await prisma.archive.findMany({ orderBy: { createdAt: "desc" } });
    res.json(archives);
  } catch (err) {
    console.error("Fetch archives error:", err);
    res.status(500).json({ error: "Failed to fetch archives" });
  }
});

export default router;
