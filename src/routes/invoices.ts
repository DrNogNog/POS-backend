import { Router } from "express";
import { PrismaClient } from "@prisma/client";

const router = Router();
const prisma = new PrismaClient();

router.post("/", async (req, res) => {
  try {
    const { invoiceNo, pdf } = req.body;

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
        pdf: pdfBuffer,
      },
    });

    res.json(saved);
  } catch (err) {
    console.error("Failed to save invoice PDF:", err);
    res.status(500).json({ error: "Failed to save PDF" });
  }
});
router.get("/", async (req, res) => {
  try {
    const invoices = await prisma.invoice.findMany({
      orderBy: { createdAt: "desc" },
    });
    res.json(invoices);
  } catch (err) {
    console.error(err);
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


export default router;
