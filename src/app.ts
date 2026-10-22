// -----------------------------------------------------------------------------
// The Express application: middleware + every route, in one readable list.
// (server.ts starts it; tests import it directly.)
// -----------------------------------------------------------------------------
import express, { type Request, type Response } from "express";
import cors from "cors";
import path from "path";
import { env } from "./config/env.js";
import { attachDb, requireAuth, workerGate } from "./middleware/auth.js";
import { errorHandler } from "./lib/http.js";

import authRoutes from "./routes/auth.js";
import settingsRoutes from "./routes/settings.js";
import supplierRoutes from "./routes/suppliers.js";
import productRoutes from "./routes/products.js";
import customerRoutes from "./routes/customers.js";
import costingRoutes from "./routes/costing.js";
import payrollRoutes from "./routes/payroll.js";
import { estimatesRouter, invoicesRouter, receivablesRouter } from "./routes/sales.js";
import { billsRouter, payablesRouter, purchaseOrdersRouter } from "./routes/purchasing.js";
import { archivesRouter, historyRouter, reportsRouter } from "./routes/reports.js";

export function createApp() {
  const app = express();
  app.disable("x-powered-by");

  // Basic security headers
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
    res.setHeader("Referrer-Policy", "no-referrer");
    next();
  });
  app.use(
    cors({
      origin: env.frontendOrigin.split(",").map((s) => s.trim()),
      methods: ["GET", "POST", "PUT", "DELETE"],
      allowedHeaders: ["Content-Type", "Authorization"],
    })
  );
  app.use(express.json({ limit: "10mb" }));

  // Product photos
  app.use("/uploads", express.static(path.join(process.cwd(), "uploads")));

  app.get("/api/health", (_req, res) => res.json({ ok: true }));

  // ---- Public ----
  app.use("/api/auth", authRoutes);

  // ---- Everything below needs a login ----
  const secured = express.Router();
  secured.use(attachDb, requireAuth, workerGate);

  secured.use("/settings", settingsRoutes); // store info, tax, price tiers, item codes
  secured.use("/products", productRoutes); // inventory
  secured.use("/suppliers", supplierRoutes);
  secured.use("/customers", customerRoutes);

  // Sales / Accounts Receivable
  secured.use("/estimates", estimatesRouter);
  secured.use("/invoices", invoicesRouter);
  secured.use("/receivables", receivablesRouter);

  // Purchasing / Accounts Payable
  secured.use("/purchase-orders", purchaseOrdersRouter);
  secured.use("/bills", billsRouter);
  secured.use("/payables", payablesRouter);

  // Accounting & people
  secured.use("/costing", costingRoutes);
  secured.use("/payroll", payrollRoutes);
  secured.use("/reports", reportsRouter);
  secured.use("/history", historyRouter);
  secured.use("/archives", archivesRouter);

  app.use("/api", secured);
  app.use(errorHandler);
  return app;
}
