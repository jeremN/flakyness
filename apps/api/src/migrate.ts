// Production migration runner (backlog #30).
//
// `pnpm db:migrate` uses tsx and drizzle-kit, which are devDependencies. The
// production image installs with `--prod`, so that command cannot run there.
// This script needs only drizzle-orm and postgres, which are runtime
// dependencies, and tsup compiles it to dist/migrate.js next to the server:
//
//   docker compose exec api node apps/api/dist/migrate.js
//
// It reads the same `drizzle/` folder and writes the same
// `drizzle.__drizzle_migrations` table as drizzle-kit, so the two runners
// can be mixed on one database.
import path from 'node:path';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { logger } from './middleware/logger';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  logger.error('DATABASE_URL environment variable is not set');
  process.exit(1);
}

// dist/migrate.js and src/migrate.ts both sit one level below apps/api, so
// `../drizzle` resolves to apps/api/drizzle in the image and in the repo.
const migrationsFolder = path.resolve(import.meta.dirname, '../drizzle');

const client = postgres(connectionString, { max: 1 });
try {
  await migrate(drizzle(client), { migrationsFolder });
  logger.info('Migrations applied', { migrationsFolder });
} catch (err) {
  const error = err instanceof Error ? err : new Error(String(err));
  logger.error('Migration failed', { error: { name: error.name, message: error.message, stack: error.stack } });
  process.exitCode = 1;
} finally {
  await client.end();
}
