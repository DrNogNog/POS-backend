import express from 'express';
import cors from 'cors';
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';
import authRoutes from './routes/auth.js';
import productRoutes from './routes/products.js';
import saleRoutes from './routes/sales.js';

dotenv.config();
const app = express();
const server = http.createServer(app);
const io = new SocketIOServer(server, { cors: { origin: true }});
const prisma = new PrismaClient();
import path from 'path';
app.use(cors());

// ⭐ Serve uploaded images
const uploadDir = path.join(process.cwd(), "uploads");
app.use("/uploads", express.static(uploadDir));

// Only parse JSON for routes that expect JSON
app.use('/api/auth', express.json(), authRoutes(prisma));
app.use('/api/sales', express.json(), saleRoutes(prisma, io));

// Products route uses multer for multipart/form-data
app.use('/api/products', productRoutes(prisma));

io.on('connection', socket => {
  console.log('socket connected', socket.id);
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log(`API listening on ${PORT}`));
