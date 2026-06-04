import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error('DATABASE_URL environment variable is not set');
}

// Configure connection pool
const queryClient = postgres(connectionString, {
  max: 20,                // Maximum connections in pool
  idle_timeout: 20,       // Close idle connections after 20s
  connect_timeout: 10,    // Fail connection attempt after 10s
});

export const db = drizzle(queryClient, { schema });

/**
 * Gracefully close all database connections.
 * Call this during server shutdown.
 */
export async function closeDb(): Promise<void> {
  await queryClient.end();
}

// Export schema for use in queries
export * from './schema';
