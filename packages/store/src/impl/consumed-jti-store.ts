import { drizzle } from 'drizzle-orm/node-postgres';
import { lt } from 'drizzle-orm';
import pg from 'pg';

import * as schema from '../schema.js';
import { consumedJtis } from '../schema.js';
import type { DrizzleDb } from './index.js';

/**
 * Single-use token ledger backing `POST /api/auth/exchange`.
 *
 * `tryConsume` returns true the first time a jti is seen and false on every
 * subsequent attempt — the unique PK + `onConflictDoNothing` makes the
 * race-free atomic check we need to prevent replay.
 */
export class DbConsumedJtiStore {
  private pool?: pg.Pool;

  constructor(private readonly db: DrizzleDb) {}

  static async open(databaseUrl?: string): Promise<DbConsumedJtiStore> {
    const url = databaseUrl ?? process.env.DATABASE_URL;
    if (!url) {
      throw new Error('DATABASE_URL environment variable is required');
    }
    const pool = new pg.Pool({ connectionString: url });
    await pool.query('SELECT 1');
    const db = drizzle(pool, { schema });
    const store = new DbConsumedJtiStore(db);
    store.pool = pool;
    return store;
  }

  async close(): Promise<void> {
    await this.pool?.end();
  }

  async tryConsume(
    jti: string,
    expiresAt: number,
    consumedAt: string,
  ): Promise<boolean> {
    const inserted = await this.db
      .insert(consumedJtis)
      .values({ jti, expiresAt, consumedAt })
      .onConflictDoNothing({ target: consumedJtis.jti })
      .returning({ jti: consumedJtis.jti });
    return inserted.length > 0;
  }

  async sweepExpired(nowSeconds: number): Promise<number> {
    const deleted = await this.db
      .delete(consumedJtis)
      .where(lt(consumedJtis.expiresAt, nowSeconds))
      .returning({ jti: consumedJtis.jti });
    return deleted.length;
  }
}
