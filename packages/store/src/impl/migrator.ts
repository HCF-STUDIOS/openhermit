import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

/**
 * Resolve the drizzle migrations folder for both layouts:
 *   - dev/tsx: file is at `packages/store/src/impl/migrator.ts`,
 *     migrations at `packages/store/drizzle/` (two levels up).
 *   - npm-bundled (apps/cli/dist/*.js or sub-chunks): migrations are
 *     copied into `<package-root>/drizzle/` by prepublishOnly, sitting
 *     alongside `dist/` (one or two levels up depending on the chunk).
 * Probe candidates in order and pick the first that has a journal file.
 */
const resolveMigrationsFolder = (): string => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, '..', '..', 'drizzle'), // dev
    path.resolve(here, '..', 'drizzle'),       // bundled at <pkg>/dist/*.js
    path.resolve(here, '..', '..', 'drizzle'), // bundled at <pkg>/dist/sub/*.js
  ];
  const found = candidates.find((p) =>
    existsSync(path.join(p, 'meta', '_journal.json')),
  );
  if (!found) {
    throw new Error(
      `drizzle migrations folder not found; searched: ${candidates.join(', ')}`,
    );
  }
  return found;
};

let runOnce: Promise<void> | null = null;

/**
 * Apply pending drizzle migrations. Idempotent — safe to call from multiple
 * boot paths; only runs once per process.
 *
 * Connection precedence: an explicit `databaseUrl` argument, else `DIRECT_URL`,
 * else `DATABASE_URL`. `migrate()` runs its DDL inside a transaction and takes a
 * migration lock, which a transaction-mode connection pooler (e.g. Supabase
 * Supavisor on port 6543 with `pgbouncer=true`) does not support — it
 * multiplexes backends per statement, so the lock and the DDL can land on
 * different sessions. When runtime traffic moves to the transaction pooler,
 * `DATABASE_URL` points at 6543; set `DIRECT_URL` to a session-mode/direct
 * connection (port 5432) so migrations keep running on a single backend. If
 * `DIRECT_URL` is unset (dev, or still on a session pooler) this transparently
 * falls back to `DATABASE_URL`, so existing environments are unaffected.
 */
export const runMigrations = async (databaseUrl?: string): Promise<void> => {
  if (runOnce) return runOnce;
  runOnce = (async () => {
    const url =
      databaseUrl ?? process.env.DIRECT_URL ?? process.env.DATABASE_URL;
    if (!url) {
      throw new Error(
        'a database connection string is required (DIRECT_URL or DATABASE_URL)',
      );
    }
    const pool = new pg.Pool({ connectionString: url });
    try {
      const db = drizzle(pool);
      await migrate(db, { migrationsFolder: resolveMigrationsFolder() });
    } finally {
      await pool.end();
    }
  })();
  return runOnce;
};
