import { Router } from "express";
import type { Request, Response } from "express";
import { PrismaClient } from "@prisma/client";

const router = Router();

export default function estimateRoutes(prisma: PrismaClient) {
  
  // CREATE ESTIMATE
  router.post("/save", async (req, res) => {
    try {
      const {
        estimateNo: providedEstimateNo,
        date,
        billTo,
        shipTo,
        subtotal,
        discount,
        total,
        pdfData,
        items = [],
        companyName = "",
        companyAddr1 = "",
        companyAddr2 = "",
        phone = "",
        fax = "",
        email = "",
        website = "",
      } = req.body;

      const last = await prisma.estimate.findFirst({
        orderBy: { id: "desc" },
        select: { estimateNo: true },
      });

      let number = 1001;
      if (last?.estimateNo?.startsWith("EST-")) {
        number = parseInt(last.estimateNo.replace("EST-", "")) + 1;
      }

      const finalEstimateNo = providedEstimateNo?.trim() || `EST-${number}`;

      const estimate = await prisma.estimate.create({
        data: {
          estimateNo: finalEstimateNo,
          date: new Date(date),
          billTo,
          shipTo,
          subtotal: Number(subtotal),
          discount: Number(discount),
          total: Number(total),
          pdfData: Buffer.from(pdfData, "base64"),
          approved: false,
          companyName,
          companyAddr1,
          companyAddr2,
          phone,
          fax,
          email,
          website,
          items,
        },
      });

      res.json({ success: true, estimate });
    } catch (err: any) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  });

  // GET ALL ESTIMATES
  router.get("/", async (_req, res) => {
    const list = await prisma.estimate.findMany({
      select: {
        id: true,
        estimateNo: true,
        date: true,
        total: true,
        approved: true,
        billTo: true,
      },
      orderBy: { createdAt: "desc" },
    });
    res.json(list);
  });

  // GET FULL ESTIMATE
  router.get("/:id", async (req, res) => {
    const est = await prisma.estimate.findUnique({
      where: { id: Number(req.params.id) },
    });

    if (!est) return res.status(404).json({ error: "Not found" });

    res.json(est);
  });

  // VIEW PDF
  router.get("/:id/pdf", async (req, res) => {
    const est = await prisma.estimate.findUnique({
      where: { id: Number(req.params.id) },
      select: { pdfData: true },
    });

    if (!est) return res.status(404).send("Not found");

    res.set("Content-Type", "application/pdf");
    res.send(est.pdfData);
  });

  // APPROVE ESTIMATE
  router.patch("/:id/approve", async (req, res) => {
    await prisma.estimate.update({
      where: { id: Number(req.params.id) },
      data: { approved: req.body.approved },
    });
    res.json({ success: true });
  });

  // MARK AS INVOICED
  router.patch("/:id/invoiced", async (req, res) => {
    await prisma.estimate.update({
      where: { id: Number(req.params.id) },
      data: { approved: true, invoiced: true },
    });
    res.json({ success: true });
  });

  // DELETE
  router.delete("/:id", async (req, res) => {
    await prisma.estimate.delete({ where: { id: Number(req.params.id) } });
    res.json({ success: true });
  });

  return router;
}
