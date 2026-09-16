import { drizzle } from 'drizzle-orm/node-postgres';
import { eq, sql } from 'drizzle-orm';
import pg from 'pg';
import { createStorePool } from './pool.js';

import * as schema from '../schema.js';
import { meta } from '../schema.js';
import type { DrizzleDb } from './index.js';

/**
 * Generic key-value store backed by the `meta` table. Values are
 * stored as text; callers are responsible for serialisation.
 */
export class DbMetaStore {
  private pool?: pg.Pool;

  constructor(private readonly db: DrizzleDb) {}

  static async open(databaseUrl?: string): Promise<DbMetaStore> {
    const url = databaseUrl ?? process.env.DATABASE_URL;
    if (!url) {
      throw new Error('DATABASE_URL environment variable is required');
    }
    const pool = createStorePool(url);
    await pool.query('SELECT 1');
    const db = drizzle(pool, { schema });
    const store = new DbMetaStore(db);
    store.pool = pool;
    return store;
  }

  async close(): Promise<void> {
    await this.pool?.end();
  }

  async get(key: string): Promise<string | null> {
    const [row] = await this.db.select({ value: meta.value })
      .from(meta).where(eq(meta.key, key));
    return row?.value ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    await this.db.insert(meta)
      .values({ key, value })
      .onConflictDoUpdate({
        target: meta.key,
        set: { value: sql`EXCLUDED.value` },
      });
  }

  async getJson<T = unknown>(key: string): Promise<T | null> {
    const raw = await this.get(key);
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  async setJson(key: string, value: unknown): Promise<void> {
    await this.set(key, JSON.stringify(value));
  }

  async delete(key: string): Promise<void> {
    await this.db.delete(meta).where(eq(meta.key, key));
  }
}
