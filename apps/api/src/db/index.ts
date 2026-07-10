import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

type Db = ReturnType<typeof drizzle<typeof schema>>;

let queryClient: ReturnType<typeof postgres> | null = null;
let realDb: Db | null = null;

function initDb(): Db {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL environment variable is not set');
  }
  queryClient = postgres(connectionString, {
    max: 20,                // Maximum connections in pool
    idle_timeout: 20,       // Close idle connections after 20s
    connect_timeout: 10,    // Fail connection attempt after 10s
  });
  return drizzle(queryClient, { schema });
}

// Lazy: created on first property access so importing this module never
// requires DATABASE_URL (unit tests import consumers without a DB).
export const db: Db = new Proxy({} as Db, {
  get(_target, prop) {
    realDb ??= initDb();
    const value = Reflect.get(realDb as object, prop);
    return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(realDb) : value;
  },
});

/**
 * Gracefully close all database connections.
 * Call this during server shutdown.
 */
export async function closeDb(): Promise<void> {
  if (queryClient) {
    await queryClient.end();
    queryClient = null;
    realDb = null;
  }
}

// Export schema for use in queries
export * from './schema';
