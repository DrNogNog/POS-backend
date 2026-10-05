// -----------------------------------------------------------------------------
// One Prisma client per store database.
//
// Store A and Store B are separate PostgreSQL databases with the same tables.
// Every request says which store it is working in (the "X-Store" header) and
// gets that store's client as `req.db`.
// -----------------------------------------------------------------------------
import { PrismaClient } from "@prisma/client";
import { env, type StoreId } from "../config/env.js";

export type Db = PrismaClient;

/** A Prisma transaction client (what you get inside db.$transaction). */
export type Tx = Omit<
  PrismaClient,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$extends"
>;

const clients = new Map<StoreId, PrismaClient>();

/** Factory is swappable so tests can plug in a different client. */
let createClient = (url: string): PrismaClient =>
  new PrismaClient({ datasources: { db: { url } }, log: ["warn", "error"] });

export function setClientFactory(factory: (url: string) => PrismaClient) {
  createClient = factory;
  clients.clear();
}

export function isKnownStore(id: string): id is StoreId {
  return env.stores.some((s) => s.id === id);
}

export function getDb(storeId: StoreId): PrismaClient {
  let client = clients.get(storeId);
  if (!client) {
    const store = env.stores.find((s) => s.id === storeId);
    if (!store) throw new Error(`Unknown store "${storeId}"`);
    client = createClient(store.databaseUrl);
    clients.set(storeId, client);
  }
  return client;
}

export async function disconnectAll() {
  await Promise.all([...clients.values()].map((c) => c.$disconnect()));
}
