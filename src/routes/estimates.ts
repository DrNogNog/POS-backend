// src/routes/estimates.ts
import { Router } from "express";
import type { Request, Response } from "express";
import { PrismaClient } from "@prisma/client";

const router = Router();

export default function estimateRoutes(prisma: PrismaClient) {
  // 1. SAVE ESTIMATE (with PDF) — AUTO-GENERATES EST-1001, EST-1002, etc.
  router.post("/save", async (req: Request, res: Response) => {
    try {
      const {
        estimateNo: providedEstimateNo,
        date,
        billTo,
        shipTo,
        subtotal,
        discount,
        total,
        pdfData, // base64 string from frontend
        customer = "Walk-in",
      } = req.body;

      // Auto-generate next estimate number
      const lastEstimate = await prisma.estimate.findFirst({
        orderBy: { id: "desc" },
        select: { estimateNo: true },
      });

      let nextNumber = 1001; // starting number
      if (lastEstimate?.estimateNo?.startsWith("EST-")) {
        const match = lastEstimate.estimateNo.match(/EST-(\d+)/);
        if (match) {
          nextNumber = parseInt(match[1]) + 1;
        }
      }

      const finalEstimateNo = providedEstimateNo?.trim() 
        ? providedEstimateNo 
        : `EST-${nextNumber}`;

      const pdfBuffer = Buffer.from(pdfData, "base64");

      const estimate = await prisma.estimate.create({
        data: {
          estimateNo: finalEstimateNo,
          date: new Date(date),
          customer,
          billTo,
          shipTo,
          subtotal: Number(subtotal),
          discount: Number(discount),
          total: Number(total),
          pdfData: pdfBuffer,
          approved: false,
        },
      });

      res.json({ 
        success: true, 
        estimate,
        message: `Estimate ${finalEstimateNo} saved!`
      });
    } catch (error: any) {
      console.error("Save estimate error:", error);
      if (error.code === "P2002") {
        res.status(400).json({ 
          error: "Estimate number already exists. Please use a unique number." 
        });
      } else {
        res.status(500).json({ error: error.message });
      }
    }
  });

  // 2. GET ALL ESTIMATES (fast — no PDF data)
  router.get("/", async (req: Request, res: Response) => {
    try {
      const estimates = await prisma.estimate.findMany({
        select: {
          id: true,
          estimateNo: true,
          date: true,
          customer: true,
          total: true,
          approved: true,
          createdAt: true,
        },
        orderBy: { createdAt: "desc" },
      });
      res.json(estimates);
    } catch (error) {
      console.error("Error fetching estimates:", error);
      res.status(500).json({ error: "Failed to load estimates" });
    }
  });

  // 3. TOGGLE APPROVED
  router.patch("/:id/approve", async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { approved } = req.body;

      await prisma.estimate.update({
        where: { id: Number(id) },
        data: { approved },
      });

      res.json({ success: true });
    } catch (error: any) {
      console.error("Error updating approval:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // 4. (Optional) GET SINGLE PDF
  router.get("/:id/pdf", async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const estimate = await prisma.estimate.findUnique({
        where: { id: Number(id) },
        select: { pdfData: true, estimateNo: true },
      });

      if (!estimate) {
        return res.status(404).json({ error: "Estimate not found" });
      }

      res.set("Content-Type", "application/pdf");
      res.set("Content-Disposition", `inline; filename="${estimate.estimateNo}.pdf"`);
      res.send(estimate.pdfData);
    } catch (error) {
      res.status(500).json({ error: "Failed to load PDF" });
    }
  });

  return router;
}