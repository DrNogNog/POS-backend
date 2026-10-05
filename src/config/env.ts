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

export type StoreId = "A" | "B";

export interface StoreConfig {
  id: StoreId;
  name: string;
  databaseUrl: string;
}

/** The stores this server can talk to. Each one is a separate database. */
function loadStores(): StoreConfig[] {
  const stores: StoreConfig[] = [
    {
      id: "A",
      name: process.env.STORE_A_NAME || "Store A",
      databaseUrl: required("DATABASE_URL_STORE_A"),
    },
  ];
  // Store B is optional so the system still runs with a single store.
  if (process.env.DATABASE_URL_STORE_B) {
    stores.push({
      id: "B",
      name: process.env.STORE_B_NAME || "Store B",
      databaseUrl: process.env.DATABASE_URL_STORE_B,
    });
  }
  return stores;
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
  stores: loadStores(),
  isProduction: process.env.NODE_ENV === "production",
};
