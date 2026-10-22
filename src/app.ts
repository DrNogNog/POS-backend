// -----------------------------------------------------------------------------
// The Express application: middleware + every route, in one readable list.
// (server.ts starts it; tests import it directly.)
// -----------------------------------------------------------------------------
import express, { type NextFunction, type Request, type Response } from "express";
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

/**
 * Login lock-out: 10 WRONG passwords for the same email in 15 minutes locks
 * that email for 15 minutes. Correct logins never count and clear the slate, so
 * staff signing in and out all day at the same counter computer are never
 * locked out. (Everyone at the store shares one address, so it can't be by IP.)
 */
function loginLimiter() {
  const failures = new Map<string, { count: number; until: number }>();
  const WINDOW = 15 * 60 * 1000;
  return (req: Request, res: Response, next: NextFunction) => {
    const email = String(req.body?.email ?? "").trim().toLowerCase();
    const key = `${req.ip || "?"}|${email}`;
    const now = Date.now();
    const f = failures.get(key);
    if (f && f.until < now) failures.delete(key);
    const current = failures.get(key);
    if (current && current.count >= 10) {
      const mins = Math.max(1, Math.ceil((current.until - now) / 60000));
      return res.status(429).json({ error: `Too many wrong passwords for this login. Try again in ${mins} minute${mins === 1 ? "" : "s"}.` });
    }
    res.on("finish", () => {
      if (res.statusCode >= 200 && res.statusCode < 300) failures.delete(key);
      else if (res.statusCode === 401 || res.statusCode === 400) {
        const g = failures.get(key);
        if (g && g.until >= Date.now()) g.count++;
        else failures.set(key, { count: 1, until: Date.now() + WINDOW });
      }
    });
    next();
  };
}

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
  app.post("/api/auth/login", loginLimiter());
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
