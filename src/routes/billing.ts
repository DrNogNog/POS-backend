// routes/billing-pdfs.ts
import express, { Request, Response } from "express";
import { PrismaClient } from "@prisma/client";

const router = express.Router();
const prisma = new PrismaClient();

// Save a PDF
router.post("/save", async (req: Request, res: Response) => {
  try {
    const { invoiceNo, pdfData, orderId, productId, name, description, vendors, count } = req.body;


    console.log("Save PDF called with:", { orderId, invoiceNo, pdfDataLength: pdfData?.length });

    if (!orderId) return res.status(400).json({ error: "Missing orderId" });

    // 1️⃣ Check if order exists
    let order = await prisma.order.findUnique({
  where: { id: Number(orderId) },
        });

        if (!order) {
        // Only create a new order if it truly doesn't exist
        order = await prisma.order.create({
            data: {
            id: Number(orderId), // remove if using auto-increment
            productId: productId || "UNKNOWN",
            name: name || "Auto-generated order",
            description: description || "",
            vendors: vendors || "",
            count: count || 1,
            createdAt: new Date(),
            },
        });
        }

    if (!pdfData) {
      return res.status(400).json({ error: "Missing PDF data" });
    }

    // 3️⃣ Save the PDF
    const billingPdf = await prisma.billingPDF.create({
      data: {
        orderId: Number(orderId),
        invoiceNo,
        pdf: Buffer.from(pdfData, "base64"),
      },
    });

    res.status(201).json({ message: "PDF saved successfully", billingPdf });
  } catch (err: any) {
    console.error("Failed to save billing PDF:", err);
    if (err.code === "P2002") {
      res.status(400).json({ error: "Invoice number already exists" });
    } else {
      res.status(500).json({ error: "Failed to save billing PDF", details: err.message });
    }
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
