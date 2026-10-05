// Login, store list, and user management (owner only).
import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { env } from "../config/env.js";
import { allow, requireAuth, selectStore, signToken } from "../middleware/auth.js";
import { badRequest, idParam, parse, route } from "../lib/http.js";
import { logActivity } from "../lib/history.js";

const router = Router();

/** Public: which stores exist (for the store picker on the login screen). */
router.get("/stores", (_req, res) => {
  res.json(env.stores.map((s) => ({ id: s.id, name: s.name })));
});

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1),
});

router.post(
  "/login",
  selectStore,
  route(async (req, res) => {
    const { email, password } = parse(loginSchema, req.body);
    const user = await req.db.user.findUnique({ where: { email } });
    const ok = user && user.active && (await bcrypt.compare(password, user.password));
    if (!ok) return res.status(401).json({ error: "Wrong email or password for this store." });
    res.json({
      token: signToken(user.email),
      user: { id: user.id, name: user.name, email: user.email, role: user.role },
      store: { id: req.storeId, name: env.stores.find((s) => s.id === req.storeId)?.name },
    });
  })
);

router.get("/me", selectStore, requireAuth, (req, res) => {
  res.json({
    user: req.user,
    store: { id: req.storeId, name: env.stores.find((s) => s.id === req.storeId)?.name },
  });
});

// ---- Users (per store) ----------------------------------------------------
const roles = z.enum(["OWNER", "MANAGER", "ACCOUNTANT", "CASHIER"]);
const userSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  name: z.string().trim().min(1),
  role: roles,
  password: z.string().min(8, "Password must be at least 8 characters").optional(),
  active: z.boolean().optional(),
});

router.get(
  "/users",
  selectStore,
  requireAuth,
  allow(),
  route(async (req, res) => {
    const users = await req.db.user.findMany({
      orderBy: { name: "asc" },
      select: { id: true, email: true, name: true, role: true, active: true, createdAt: true },
    });
    res.json(users);
  })
);

router.post(
  "/users",
  selectStore,
  requireAuth,
  allow(),
  route(async (req, res) => {
    const input = parse(userSchema, req.body);
    if (!input.password) throw badRequest("Password is required for a new user");
    const user = await req.db.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          email: input.email,
          name: input.name,
          role: input.role,
          password: await bcrypt.hash(input.password!, 12),
        },
        select: { id: true, email: true, name: true, role: true, active: true },
      });
      await logActivity(tx, {
        entityType: "User",
        entityId: created.id,
        entityRef: created.email,
        action: "CREATED",
        summary: `User ${created.name} (${created.role}) added`,
        userName: req.user.name,
      });
      return created;
    });
    res.status(201).json(user);
  })
);

router.put(
  "/users/:id",
  selectStore,
  requireAuth,
  allow(),
  route(async (req, res) => {
    const id = idParam(req);
    const input = parse(userSchema.partial(), req.body);
    if (id === req.user.id && input.active === false) throw badRequest("You can't deactivate yourself");
    const user = await req.db.$transaction(async (tx) => {
      const updated = await tx.user.update({
        where: { id },
        data: {
          ...(input.email ? { email: input.email } : {}),
          ...(input.name ? { name: input.name } : {}),
          ...(input.role ? { role: input.role } : {}),
          ...(input.active !== undefined ? { active: input.active } : {}),
          ...(input.password ? { password: await bcrypt.hash(input.password, 12) } : {}),
        },
        select: { id: true, email: true, name: true, role: true, active: true },
      });
      await logActivity(tx, {
        entityType: "User",
        entityId: id,
        entityRef: updated.email,
        action: "UPDATED",
        summary: `User ${updated.name} updated${input.password ? " (password changed)" : ""}`,
        userName: req.user.name,
      });
      return updated;
    });
    res.json(user);
  })
);

export default router;
