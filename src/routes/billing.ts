// routes/billing-pdfs.ts
import express, { Request, Response } from "express";
import { PrismaClient } from "@prisma/client";

const router = express.Router();
const prisma = new PrismaClient();






// Get all PDFs (for mapping in the frontend)
router.get("/", async (req: Request, res: Response) => {
  try {
    const pdfs = await prisma.billingPDF.findMany({
      select: { orderId: true, invoiceNo: true, cost: true, createdAt: true },
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


// routes/billing.ts or inside your products router
router.post("/save-pdf", async (req: Request, res: Response) => {
  try {
    const { orderId, invoiceNo, cost, pdfBase64 } = req.body;

    // Validate
    if (!orderId || !invoiceNo || !pdfBase64) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // Convert base64 to Buffer
    const pdfBuffer = Buffer.from(pdfBase64.split(",")[1] || pdfBase64, "base64");

    // Save to database
    const savedPdf = await prisma.billingPDF.create({
      data: {
        orderId: Number(orderId),
        invoiceNo,
        cost,
        pdf: pdfBuffer, // Prisma stores as Bytes
      },
    });

    res.json({ success: true, id: savedPdf.id, invoiceNo });
  } catch (error: any) {
    console.error("Failed to save billing PDF:", error);
    if (error.code === "P2002") {
      return res.status(400).json({ error: "Invoice number already exists" });
    }
    res.status(500).json({ error: "Failed to save PDF" });
  }
});
export default router;
