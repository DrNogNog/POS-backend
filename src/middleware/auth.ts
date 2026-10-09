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

/**
 * Worker logins can only make estimates and look at the approvals list.
 * Everything a worker may call is listed here; anything else is refused,
 * whatever the screen shows. (Approving and invoicing stay with the
 * owner / manager / cashier logins.)
 */
const WORKER_ALLOWED: [method: string, path: RegExp][] = [
  ["GET", /^\/settings$/], // tax rates and price levels for pricing the estimate
  ["GET", /^\/products$/], // item search
  ["GET", /^\/products\/availability$/], // stock on hand / promised
  ["GET", /^\/customers$/],
  ["GET", /^\/customers\/\d+$/],
  ["POST", /^\/customers$/], // add a walk-in customer
  ["PUT", /^\/customers\/\d+$/],
  ["GET", /^\/estimates$/], // the approvals list
  ["GET", /^\/estimates\/\d+$/],
  ["GET", /^\/estimates\/\d+\/pdf$/],
  ["POST", /^\/estimates$/], // create an estimate
  ["PUT", /^\/estimates\/\d+$/], // change one still waiting for approval (checked in the route)
];

export function workerGate(req: Request, res: Response, next: NextFunction) {
  if (req.user?.role !== "WORKER") return next();
  const path = req.path.replace(/\/+$/, "") || "/";
  const ok = WORKER_ALLOWED.some(([m, re]) => m === req.method && re.test(path));
  if (ok) return next();
  return res.status(403).json({ error: "Worker logins can only create estimates and view approvals." });
}

/** Roles that can see and change the books. */
export const BOOKKEEPERS: Role[] = ["MANAGER", "ACCOUNTANT"];
