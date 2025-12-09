// src/server.ts
import express from 'express';
import cors from 'cors';
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';
import path from 'path';

// Import routes
import authRoutes from './routes/auth.js';
import productRoutes from './routes/products.js';
import { productChangeLogRoutes } from './routes/product-change-logs.js';
import estimateRoutes from './routes/estimates.js';
import invoiceRoutes from "./routes/invoices.js";
import archiveRouter from "./routes/archives.js";
import billingRouter from "./routes/billing.js";
import session from "express-session";
// Load .env (critical for DATABASE_URL)
dotenv.config();


// Also handle preflight
// Create PrismaClient with correct config for Prisma 7+
const prisma = new PrismaClient({
  datasources: {
    db: {
      url: process.env.DATABASE_URL ?? "postgresql://localhost:5432/placeholder",
    },
  },
});

// Graceful shutdown
process.on('SIGINT', async () => {
  await prisma.$disconnect();
  process.exit(0);
});

const app = express();
const server = http.createServer(app);
const io = new SocketIOServer(server, { cors: { origin: true } });

// Middleware
app.use(
  cors({
    origin: "http://localhost:3000",        // Your Next.js app
    credentials: true,                      // This is critical!
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

app.use(
  session({
    secret: process.env.SESSION_SECRET || "supersecretkey",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: false,        // MUST be false on localhost (no HTTPS)
      sameSite: "lax",      // "lax" works perfectly on localhost
      maxAge: 24 * 60 * 60 * 1000,
    },
  })
);
app.use(express.json()); // Safe to use globally now

// Serve uploaded images
const uploadDir = path.join(process.cwd(), "uploads");
app.use("/uploads", express.static(uploadDir));
app.use("/api/invoices", invoiceRoutes);
// Routes
app.use("/api/auth", authRoutes(prisma));                 // Auth
app.use("/api/product-change-logs", productChangeLogRoutes(prisma)); // Product Change Logs
app.use("/api/products", productRoutes(prisma));          // Products (with multer)          // Sales + socket
app.use("/api/estimates", estimateRoutes(prisma));
app.use("/api/archives", archiveRouter);
app.use("/api/billing", billingRouter);
// Socket.io
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});