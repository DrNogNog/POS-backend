// -----------------------------------------------------------------------------
// Login for every request.
//
//  1. The browser sends   Authorization: Bearer <token>
//  2. We verify the token and look the user up in this store's database
//     (whichever drive PostgreSQL is running from).
//  3. Routes then use `req.db` (the database) and `req.user`.
// -----------------------------------------------------------------------------
import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import type { Role } from "@prisma/client";
import { env } from "../config/env.js";
import { getDb, type Db } from "../db/stores.js";

export interface AuthUser {
  id: number;
  email: string;
  name: string;
  role: Role;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      db: Db;
      user: AuthUser;
    }
  }
}

interface TokenPayload {
  email: string;
}

export function signToken(email: string): string {
  return jwt.sign({ email } satisfies TokenPayload, env.jwtSecret, {
    expiresIn: env.jwtExpiresIn as jwt.SignOptions["expiresIn"],
  });
}

/** Attaches the database to the request. */
export function attachDb(req: Request, _res: Response, next: NextFunction) {
  req.db = getDb();
  next();
}

/** Requires a valid login. */
export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  try {
    const header = req.header("Authorization") || "";
    // PDFs open in a new browser tab, which can't send headers, so we also
    // accept ?token= for GET requests only.
    const token = header.startsWith("Bearer ")
      ? header.slice(7)
      : req.method === "GET" && typeof req.query.token === "string"
        ? req.query.token
        : "";
    if (!token) return res.status(401).json({ error: "Please log in." });

    const payload = jwt.verify(token, env.jwtSecret) as TokenPayload;
    const user = await req.db.user.findUnique({ where: { email: payload.email } });
    if (!user || !user.active) {
      return res.status(403).json({ error: "You don't have an account in this store." });
    }
    req.user = { id: user.id, email: user.email, name: user.name || user.email, role: user.role };
    next();
  } catch {
    return res.status(401).json({ error: "Your login has expired. Please log in again." });
  }
}

/** Restrict a route to certain roles. OWNER can always do everything. */
export function allow(...roles: Role[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.user.role === "OWNER" || roles.includes(req.user.role)) return next();
    return res.status(403).json({ error: "Your role is not allowed to do this." });
  };
}

/** Roles that can see and change the books. */
export const BOOKKEEPERS: Role[] = ["MANAGER", "ACCOUNTANT"];
