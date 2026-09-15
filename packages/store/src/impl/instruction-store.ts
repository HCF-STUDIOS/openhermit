import { drizzle } from 'drizzle-orm/node-postgres';
import { eq, and, asc } from 'drizzle-orm';
import pg from 'pg';
import { createStorePool } from './pool.js';

import type { InstructionStore } from '../interfaces.js';
import type { InstructionEntry, StoreScope } from '../types.js';
import * as schema from '../schema.js';
import { instructions } from '../schema.js';
import type { DrizzleDb } from './index.js';

export class DbInstructionStore implements InstructionStore {
  private pool?: pg.Pool;

  constructor(private readonly db: DrizzleDb) {}

  static async open(databaseUrl?: string): Promise<DbInstructionStore> {
    const url = databaseUrl ?? process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL environment variable is required');
    const pool = createStorePool(url);
    await pool.query('SELECT 1');
    const db = drizzle(pool, { schema });
    const store = new DbInstructionStore(db);
    store.pool = pool;
    return store;
  }

  async close(): Promise<void> {
    await this.pool?.end();
  }

  async get(scope: StoreScope, key: string): Promise<InstructionEntry | undefined> {
    const [row] = await this.db.select().from(instructions)
      .where(and(eq(instructions.agentId, scope.agentId), eq(instructions.key, key)));
    if (!row) return undefined;
    return { key: row.key, content: row.content, updatedAt: row.updatedAt };
  }

  async getAll(scope: StoreScope): Promise<InstructionEntry[]> {
    const rows = await this.db.select().from(instructions)
      .where(eq(instructions.agentId, scope.agentId))
      .orderBy(asc(instructions.key));
    return rows.map((row) => ({ key: row.key, content: row.content, updatedAt: row.updatedAt }));
  }

  async set(scope: StoreScope, key: string, content: string, updatedAt: string): Promise<void> {
    await this.db.insert(instructions)
      .values({ agentId: scope.agentId, key, content, updatedAt })
      .onConflictDoUpdate({
        target: [instructions.agentId, instructions.key],
        set: { content, updatedAt },
      });
  }

  async delete(scope: StoreScope, key: string): Promise<void> {
    await this.db.delete(instructions)
      .where(and(eq(instructions.agentId, scope.agentId), eq(instructions.key, key)));
  }
}
