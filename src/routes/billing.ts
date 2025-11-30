// routes/billing-pdfs.ts
import express, { Request, Response } from "express";
import { PrismaClient } from "@prisma/client";

const router = express.Router();
const prisma = new PrismaClient();

// Save a PDF
router.post("/save", async (req: Request, res: Response) => {
  try {
    const { pdfData, invoiceNo, orderId } = req.body;

    if (!pdfData || !invoiceNo || !orderId) {
      return res.status(400).json({ error: "Missing pdfData, invoiceNo, or orderId" });
    }

    const pdfBuffer = Buffer.from(pdfData, "base64");

    const saved = await prisma.billingPDF.create({
      data: {
        orderId: Number(orderId),
        invoiceNo,
        pdf: pdfBuffer,
      },
    });

    res.status(200).json({ message: "PDF saved successfully", id: saved.id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to save PDF" });
  }
});

// Get all PDFs (for mapping in the frontend)
router.get("/", async (req: Request, res: Response) => {
  try {
    const pdfs = await prisma.billingPDF.findMany({
      select: { orderId: true, invoiceNo: true, createdAt: true },
    });
    res.status(200).json(pdfs);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch PDFs" });
  }
});
router.get("/view", async (req: Request, res: Response) => {
  const orderId = Number(req.query.orderId);
  if (!orderId) return res.status(400).json({ error: "Missing orderId" });

  try {
    const pdfRecord = await prisma.billingPDF.findFirst({
      where: { orderId }
    });

    if (!pdfRecord) return res.status(404).json({ error: "PDF not found" });

    res.setHeader("Content-Type", "application/pdf");
    res.send(pdfRecord.pdf);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch PDF" });
  }
});

export default router;
