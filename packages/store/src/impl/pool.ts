import pg from 'pg';

/**
 * Upper bound on client connections held by a single store's pool.
 *
 * Every DB-backed store opens its own `pg.Pool`, so the process-wide ceiling is
 * (number of stores) × this value. node-postgres defaults to `max: 10`, which
 * across the ~18 stores means up to ~180 connections from one gateway process —
 * enough to exhaust the connection pooler and surface as `EMAXCONNSESSION`
 * under burst. Bounding each pool keeps the aggregate well within the pooler's
 * capacity. Override with `DB_POOL_MAX` (e.g. lower it further when running
 * against a session-mode pooler with a small `pool_size`).
 */
const DEFAULT_MAX = 5;

export const storePoolMax = (): number => {
  const raw = Number(process.env.DB_POOL_MAX);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_MAX;
};

/**
 * Construct a store pool with the shared connection-count bound applied. All
 * DB-backed stores go through this so the ceiling is defined in one place.
 */
export const createStorePool = (connectionString: string): pg.Pool =>
  new pg.Pool({ connectionString, max: storePoolMax() });
