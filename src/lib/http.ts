// -----------------------------------------------------------------------------
// Small helpers for writing Express routes without repeating try/catch.
// -----------------------------------------------------------------------------
import type { NextFunction, Request, Response, RequestHandler } from "express";
import { ZodError, type ZodType } from "zod";

/** Throw this from any route to send a clean error to the user. */
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
  }
}

export const badRequest = (msg: string) => new HttpError(400, msg);
export const notFound = (what = "Record") => new HttpError(404, `${what} not found`);

/** Wrap an async route so thrown errors go to the error handler. */
export function route(
  fn: (req: Request, res: Response) => Promise<unknown>
): RequestHandler {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

/** Validate a request body (or query) against a zod schema. */
export function parse<T>(schema: ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) throw result.error;
  return result.data;
}

/**
 * For edits (PUT): keep only the fields the user actually sent, so schema
 * defaults never overwrite values that weren't part of the edit.
 */
export function onlySent<T extends object>(parsed: T, raw: unknown): Partial<T> {
  const sent = raw && typeof raw === "object" ? Object.keys(raw as object) : [];
  return Object.fromEntries(Object.entries(parsed).filter(([k]) => sent.includes(k))) as Partial<T>;
}

/** Read a numeric :id route param. */
export function idParam(req: Request, name = "id"): number {
  const id = Number(req.params[name]);
  if (!Number.isInteger(id) || id <= 0) throw badRequest(`Invalid ${name}`);
  return id;
}

/** Final error handler: turns any error into a JSON response. */
export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction
) {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message });
  }
  if (err instanceof ZodError) {
    const first = err.issues[0];
    const where = first?.path?.length ? `${first.path.join(".")}: ` : "";
    return res.status(400).json({ error: `${where}${first?.message ?? "Invalid input"}` });
  }
  // Prisma known errors
  const code = (err as { code?: string })?.code;
  if (code === "P2002") {
    return res.status(409).json({ error: "That number/code already exists." });
  }
  if (code === "P2025") {
    return res.status(404).json({ error: "Record not found" });
  }
  console.error("Unexpected error:", err instanceof Error ? err.message : err);
  return res.status(500).json({ error: "Something went wrong. Please try again." });
}
