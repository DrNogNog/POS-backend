import { Router } from 'express';
import type { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

export type RegisterRequest = {
  name: string;
  email: string;
  password: string;
};

export type LoginRequest = {
  email: string;
  password: string;
};

export default function(prisma: PrismaClient) {
  const router = Router();
  const JWT_SECRET = process.env.JWT_SECRET || 'supersecret'; // replace with env variable

  // POST /auth/register
  router.post('/register', async (req: Request<any, any, RegisterRequest>, res: Response) => {
    try {
      const { name, email, password } = req.body;

      // check if user exists
      const existingUser = await prisma.user.findUnique({ where: { email } });
      if (existingUser) {
        return res.status(400).json({ error: 'Email already registered' });
      }

      // hash password
      const hashedPassword = await bcrypt.hash(password, 10);

      const user = await prisma.user.create({
        data: {
            email,
            password: hashedPassword,
            name: name ?? null, // optional
            role: 'cashier'     // assign a default role
        }
      });


      // return user (omit password)
      const { password: _, ...userSafe } = user;
      res.status(201).json(userSafe);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'failed to register user' });
    }
  });

  // POST /auth/login
  router.post('/login', async (req: Request<any, any, LoginRequest>, res: Response) => {
    try {
      const { email, password } = req.body;

      const user = await prisma.user.findUnique({ where: { email } });
      if (!user) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      const passwordMatch = await bcrypt.compare(password, user.password);
      if (!passwordMatch) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      // generate JWT
      const token = jwt.sign({ userId: user.id, email: user.email }, JWT_SECRET, { expiresIn: '8h' });

      res.json({ token, user: { id: user.id, name: user.name, email: user.email } });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'failed to login' });
    }
  });

  return router;
}
