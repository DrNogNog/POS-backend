import { Router } from "express";
import { PrismaClient } from "@prisma/client";

const router = Router();
const prisma = new PrismaClient();

router.post("/", async (req, res) => {
  try {
    const { invoiceNo, total, pdf } = req.body;

    if (!pdf || !invoiceNo) {
      return res.status(400).json({ error: "Missing invoiceNo or PDF" });
    }

    // 1️⃣ Check if invoice already exists
    const existingInvoice = await prisma.invoice.findUnique({
      where: { invoiceNo },
    });

    if (existingInvoice) {
      return res
        .status(409)
        .json({ error: "Invoice already exists for this estimate" });
    }

    // 2️⃣ Convert PDF from base64
    const pdfBuffer = Buffer.from(pdf, "base64");

    // 3️⃣ Save new invoice
    const saved = await prisma.invoice.create({
      data: {
        invoiceNo,
        total,
        paidAmount: 0,                    // ← explicitly set
        dueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days from now
        pdf: pdfBuffer,
        status: "PENDING",
      },
    });

    res.json(saved);
  } catch (err) {
    console.error("Failed to save invoice PDF:", err);
    res.status(500).json({ error: "Failed to save PDF" });
  }
});
// routes/invoices.ts
router.get("/", async (req, res) => {
  try {
    const invoices = await prisma.invoice.findMany({
      orderBy: { createdAt: "desc" },
    });

    const safeInvoices = invoices.map(inv => ({
      id: inv.id,
      invoiceNo: inv.invoiceNo,
      total: inv.total.toString(),
      paidAmount: inv.paidAmount.toString(),
      dueDate: inv.dueDate.toISOString(),
      createdAt: inv.createdAt.toISOString(),
      status: inv.status,
    }));

    res.json(safeInvoices);
  } catch (err: any) {
    console.error("GET invoices error:", err);
    res.status(500).json({ error: "Failed to fetch invoices" });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const invoice = await prisma.invoice.findUnique({
      where: { id },
    });
    if (!invoice) return res.status(404).json({ error: "Invoice not found" });
    res.json(invoice);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch invoice" });
  }
});
router.delete("/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid invoice ID" });

  try {
    await prisma.invoice.delete({ where: { id } });
    res.status(200).json({ message: "Invoice deleted" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to delete invoice" });
  }
});
router.put("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { dueDate, status } = req.body;

    const updateData: any = {};
    if (dueDate) updateData.dueDate = new Date(dueDate);
    if (status) updateData.status = status;

    const updated = await prisma.invoice.update({
      where: { id: Number(id) },
      data: updateData,
    });

    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update invoice" });
  }
});
// routes/invoices.ts
router.post("/:id/pay", async (req, res) => {
  try {
    const invoiceId = Number(req.params.id);
    const { amount } = req.body;
    const paymentAmount = parseFloat(amount);

    if (isNaN(paymentAmount) || paymentAmount <= 0) {
      return res.status(400).json({ error: "Invalid amount" });
    }

    const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } });
    if (!invoice) return res.status(404).json({ error: "Invoice not found" });

    const newPaid = invoice.paidAmount.toNumber() + paymentAmount;
    const total = invoice.total.toNumber();
    const isPaid = newPaid >= total;

    await prisma.invoice.update({
      where: { id: invoiceId },
      data: {
        paidAmount: newPaid > total ? total : newPaid,
        status: isPaid ? "PAID" : newPaid > 0 ? "PARTIALLY_PAID" : "PENDING",
      },
    });

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Payment failed" });
  }
});

export default router;
