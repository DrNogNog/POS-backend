// routes/billing.ts
import express, { Request, Response } from "express";
import { PrismaClient } from "@prisma/client";

const router = express.Router();
const prisma = new PrismaClient();






// Get all PDFs (for mapping in the frontend)
router.get("/", async (req: Request, res: Response) => {
  try {
    const invoices = await prisma.billingPDF.findMany({
      select: {
        id: true,
        invoiceNo: true,
        orderId: true,
        cost: true,
        amountPaid: true,
        paidAt: true,
        createdAt: true,
      },
      orderBy: { createdAt: "desc" },
    });

    console.log("Raw invoices from Prisma:", invoices);
    // → You will see: cost: Decimal { ... }, amountPaid: Decimal { ... }

    // FIX: Convert Decimals to strings BEFORE sending
    const safeInvoices = invoices.map(inv => ({
      id: inv.id,
      invoiceNo: inv.invoiceNo,
      orderId: inv.orderId,
      cost: inv.cost.toString(),
      amountPaid: inv.amountPaid.toString(),
      paidAt: inv.paidAt,
      createdAt: inv.createdAt,
    }));

    console.log("Safe invoices sent to frontend:", safeInvoices);

    res.json(safeInvoices);
  } catch (err) {
    console.error("FATAL ERROR in GET /billing:", err);
    res.status(500).json({ error: "Failed to fetch invoices" });
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
// POST /api/billing/:id/pay
router.post("/:id/pay", async (req: Request, res: Response) => {
  try {
    const invoiceId = Number(req.params.id);
    const { amount } = req.body;

    const paymentAmount = Number(amount);
    if (isNaN(paymentAmount) || paymentAmount <= 0) {
      return res.status(400).json({ error: "Invalid payment amount" });
    }

    const invoice = await prisma.billingPDF.findUnique({
      where: { id: invoiceId },
    });

    if (!invoice) {
      return res.status(404).json({ error: "Invoice not found" });
    }

    // Critical fix: safely handle null amountPaid from old records
    const currentPaid = Number(invoice.amountPaid ?? 0);
    const totalCost = Number(invoice.cost);

    if (isNaN(currentPaid) || isNaN(totalCost)) {
      return res.status(500).json({ error: "Corrupted invoice data" });
    }

    const newPaidAmount = Math.min(currentPaid + paymentAmount, totalCost);
    const isFullyPaid = newPaidAmount >= totalCost;

    const updated = await prisma.billingPDF.update({
      where: { id: invoiceId },
      data: {
        amountPaid: newPaidAmount,
        paidAt: isFullyPaid ? new Date() : null,
      },
    });

    return res.json({
      success: true,
      message: isFullyPaid ? "Paid in full!" : "Payment recorded",
      remaining: totalCost - newPaidAmount,
    });
  } catch (error: any) {
    console.error("Payment error:", error);
    return res.status(500).json({ 
      error: "Payment processing failed",
      details: error.message 
    });
  }
});
export default router;
