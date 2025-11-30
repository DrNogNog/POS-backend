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

import estimateRoutes from './routes/estimates.js';
import invoiceRoutes from "./routes/invoices.js";

 
// Load .env (critical for DATABASE_URL)
dotenv.config();

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
app.use(cors());
app.use(express.json()); // Safe to use globally now

// Serve uploaded images
const uploadDir = path.join(process.cwd(), "uploads");
app.use("/uploads", express.static(uploadDir));
app.use("/api/invoices", invoiceRoutes);
// Routes
app.use("/api/auth", authRoutes(prisma));                 // Auth
app.use("/api/products", productRoutes(prisma));          // Products (with multer)          // Sales + socket
app.use("/api/estimates", estimateRoutes(prisma));
// Socket.io
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});