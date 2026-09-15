import { randomUUID } from 'node:crypto';

import { drizzle } from 'drizzle-orm/node-postgres';
import { and, eq, ne, asc } from 'drizzle-orm';
import pg from 'pg';
import { createStorePool } from './pool.js';

import type { SandboxStore } from '../interfaces.js';
import type {
  SandboxCreateInput,
  SandboxRecord,
  SandboxStatus,
  SandboxType,
} from '../types.js';
import * as schema from '../schema.js';
import { sandboxes } from '../schema.js';
import type { DrizzleDb } from './index.js';

export class DbSandboxStore implements SandboxStore {
  private pool?: pg.Pool;

  constructor(private readonly db: DrizzleDb) {}

  static async open(databaseUrl?: string): Promise<DbSandboxStore> {
    const url = databaseUrl ?? process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL environment variable is required');
    const pool = createStorePool(url);
    await pool.query('SELECT 1');
    const db = drizzle(pool, { schema });
    const store = new DbSandboxStore(db);
    store.pool = pool;
    return store;
  }

  async close(): Promise<void> {
    await this.pool?.end();
  }

  async create(input: SandboxCreateInput): Promise<SandboxRecord> {
    const now = new Date().toISOString();
    const id = input.id ?? randomUUID();
    const row = {
      id,
      agentId: input.agentId,
      alias: input.alias,
      type: input.type,
      externalId: input.externalId ?? null,
      status: input.status ?? 'pending',
      config: input.config ?? {},
      runtimeState: input.runtimeState ?? {},
      createdAt: now,
      updatedAt: now,
      lastSeenAt: null,
    };
    await this.db.insert(sandboxes).values(row);
    return this.rowToRecord(row);
  }

  async get(id: string): Promise<SandboxRecord | undefined> {
    const [row] = await this.db.select().from(sandboxes).where(eq(sandboxes.id, id));
    return row ? this.rowToRecord(row) : undefined;
  }

  async getByAlias(agentId: string, alias: string): Promise<SandboxRecord | undefined> {
    const [row] = await this.db
      .select()
      .from(sandboxes)
      .where(
        and(
          eq(sandboxes.agentId, agentId),
          eq(sandboxes.alias, alias),
          ne(sandboxes.status, 'deleted'),
        ),
      );
    return row ? this.rowToRecord(row) : undefined;
  }

  async listByAgent(agentId: string): Promise<SandboxRecord[]> {
    const rows = await this.db
      .select()
      .from(sandboxes)
      .where(and(eq(sandboxes.agentId, agentId), ne(sandboxes.status, 'deleted')))
      .orderBy(asc(sandboxes.alias));
    return rows.map((r) => this.rowToRecord(r));
  }

  async listAll(): Promise<SandboxRecord[]> {
    const rows = await this.db
      .select()
      .from(sandboxes)
      .where(ne(sandboxes.status, 'deleted'))
      .orderBy(asc(sandboxes.agentId), asc(sandboxes.alias));
    return rows.map((r) => this.rowToRecord(r));
  }

  async update(
    id: string,
    patch: Partial<{
      status: SandboxStatus;
      externalId: string | null;
      config: Record<string, unknown>;
      runtimeState: Record<string, unknown>;
      lastSeenAt: string | null;
    }>,
  ): Promise<SandboxRecord | undefined> {
    const set: Record<string, unknown> = { updatedAt: new Date().toISOString() };
    if (patch.status !== undefined) set['status'] = patch.status;
    if (patch.externalId !== undefined) set['externalId'] = patch.externalId;
    if (patch.config !== undefined) set['config'] = patch.config;
    if (patch.runtimeState !== undefined) set['runtimeState'] = patch.runtimeState;
    if (patch.lastSeenAt !== undefined) set['lastSeenAt'] = patch.lastSeenAt;

    const [row] = await this.db
      .update(sandboxes)
      .set(set)
      .where(eq(sandboxes.id, id))
      .returning();
    return row ? this.rowToRecord(row) : undefined;
  }

  async delete(id: string): Promise<void> {
    // Soft delete: keep the row for audit, but it stops being selected by
    // listByAgent / getByAlias / findAgentByType.
    await this.db
      .update(sandboxes)
      .set({ status: 'deleted', updatedAt: new Date().toISOString() })
      .where(eq(sandboxes.id, id));
  }

  async findAgentByType(type: string, excludeAgentId?: string): Promise<string | null> {
    const where = excludeAgentId
      ? and(eq(sandboxes.type, type), ne(sandboxes.agentId, excludeAgentId), ne(sandboxes.status, 'deleted'))
      : and(eq(sandboxes.type, type), ne(sandboxes.status, 'deleted'));
    const [row] = await this.db.select({ agentId: sandboxes.agentId }).from(sandboxes).where(where).limit(1);
    return row?.agentId ?? null;
  }

  private rowToRecord(row: typeof sandboxes.$inferSelect): SandboxRecord {
    return {
      id: row.id,
      agentId: row.agentId,
      alias: row.alias,
      type: row.type as SandboxType,
      externalId: row.externalId,
      status: row.status as SandboxStatus,
      config: row.config,
      runtimeState: row.runtimeState,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      lastSeenAt: row.lastSeenAt,
    };
  }
}
