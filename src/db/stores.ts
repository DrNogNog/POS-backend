// -----------------------------------------------------------------------------
// The database client.
//
// The POS uses one PostgreSQL database (DATABASE_URL). Each store keeps its
// own data on its own drive by pointing PostgreSQL's data_directory at that
// drive's mount path, so the app itself never needs to know about stores.
// Routes get the client as `req.db`.
// -----------------------------------------------------------------------------
import { PrismaClient } from "@prisma/client";
import { env } from "../config/env.js";

export type Db = PrismaClient;

/** A Prisma transaction client (what you get inside db.$transaction). */
export type Tx = Omit<
  PrismaClient,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$extends"
>;

let client: PrismaClient | null = null;

/** Factory is swappable so tests can plug in a different client. */
let createClient = (url: string): PrismaClient =>
  new PrismaClient({ datasources: { db: { url } }, log: ["warn", "error"] });

export function setClientFactory(factory: (url: string) => PrismaClient) {
  createClient = factory;
  client = null;
}

export function getDb(): PrismaClient {
  if (!client) client = createClient(env.databaseUrl);
  return client;
}

export async function disconnectAll() {
  if (client) await client.$disconnect();
  client = null;
}

/** Where the database lives, without the password — for log messages. */
export function describeDatabase(): string {
  try {
    const u = new URL(env.databaseUrl);
    return `${u.hostname}:${u.port || 5432}${u.pathname}`;
  } catch {
    return "(DATABASE_URL)";
  }
}
