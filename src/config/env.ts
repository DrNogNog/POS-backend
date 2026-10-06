// -----------------------------------------------------------------------------
// Environment configuration.
//
// Everything secret or machine-specific lives in the .env file (never in git).
// See .env.example for the full list.
// -----------------------------------------------------------------------------
import dotenv from "dotenv";

dotenv.config();

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(
      `Missing environment variable ${name}. Copy .env.example to .env and fill it in.`
    );
  }
  return value;
}

/**
 * The ONE database this server uses. Which store's data that is depends on
 * where PostgreSQL keeps its files (its data_directory) — e.g. a USB drive
 * per store. Plug in / point at a different drive and the POS shows that
 * store's data. The store's name, address and taxes live in Settings.
 *
 * DATABASE_URL_STORE_A is still accepted so older .env files keep working.
 */
function databaseUrl(): string {
  const url = process.env.DATABASE_URL || process.env.DATABASE_URL_STORE_A;
  if (!url || !url.trim()) {
    throw new Error("Missing environment variable DATABASE_URL. Copy .env.example to .env and fill it in.");
  }
  return url;
}

const jwtSecret = required("JWT_SECRET");
if (jwtSecret.length < 32) {
  throw new Error("JWT_SECRET must be at least 32 characters long.");
}

export const env = {
  port: Number(process.env.PORT || 4000),
  /** The web app's address, e.g. http://localhost:3000 (for CORS). */
  frontendOrigin: process.env.FRONTEND_ORIGIN || "http://localhost:3000",
  jwtSecret,
  /** How long a login lasts. */
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || "12h",
  databaseUrl: databaseUrl(),
  isProduction: process.env.NODE_ENV === "production",
};
