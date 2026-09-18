import { drizzle } from 'drizzle-orm/node-postgres';
import { eq, sql } from 'drizzle-orm';
import pg from 'pg';
import { createStorePool } from './pool.js';

import { readPath, writePath } from '@openhermit/shared';

import type { AgentConfigStore } from '../interfaces.js';
import * as schema from '../schema.js';
import { agents } from '../schema.js';
import type { DrizzleDb } from './index.js';

const parseJsonOrNull = (raw: string | null): Record<string, unknown> | null => {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

export class DbAgentConfigStore implements AgentConfigStore {
  private pool?: pg.Pool;

  constructor(private readonly db: DrizzleDb) {}

  static async open(databaseUrl?: string): Promise<DbAgentConfigStore> {
    const url = databaseUrl ?? process.env.DATABASE_URL;
    if (!url) {
      throw new Error('DATABASE_URL environment variable is required');
    }
    const pool = createStorePool(url);
    await pool.query('SELECT 1');
    const db = drizzle(pool, { schema });
    const store = new DbAgentConfigStore(db);
    store.pool = pool;
    return store;
  }

  async close(): Promise<void> {
    await this.pool?.end();
  }

  /** Cheap liveness probe: round-trips a `SELECT 1` to confirm the DB pool is reachable. */
  async ping(): Promise<void> {
    await this.db.execute(sql`select 1`);
  }

  async getConfig(agentId: string): Promise<Record<string, unknown> | null> {
    const [row] = await this.db.select({ configJson: agents.configJson })
      .from(agents).where(eq(agents.agentId, agentId));
    return parseJsonOrNull(row?.configJson ?? null);
  }

  async setConfig(agentId: string, config: Record<string, unknown>): Promise<void> {
    const json = JSON.stringify(config);
    const updatedAt = new Date().toISOString();
    await this.db.update(agents)
      .set({ configJson: json, updatedAt })
      .where(eq(agents.agentId, agentId));
  }

  async getSecurity(agentId: string): Promise<Record<string, unknown> | null> {
    const [row] = await this.db.select({ securityJson: agents.securityJson })
      .from(agents).where(eq(agents.agentId, agentId));
    return parseJsonOrNull(row?.securityJson ?? null);
  }

  async setSecurity(agentId: string, policy: Record<string, unknown>): Promise<void> {
    const json = JSON.stringify(policy);
    const updatedAt = new Date().toISOString();
    await this.db.update(agents)
      .set({ securityJson: json, updatedAt })
      .where(eq(agents.agentId, agentId));
  }

  async getConfigPath(agentId: string, path: string): Promise<unknown> {
    return readPath(await this.getConfig(agentId), path);
  }

  async setConfigPath(agentId: string, path: string, value: unknown): Promise<void> {
    const current = await this.getConfig(agentId);
    const next = writePath(current, path, value);
    await this.setConfig(agentId, next);
  }

  async getSecurityPath(agentId: string, path: string): Promise<unknown> {
    return readPath(await this.getSecurity(agentId), path);
  }

  async setSecurityPath(agentId: string, path: string, value: unknown): Promise<void> {
    const current = await this.getSecurity(agentId);
    const next = writePath(current, path, value);
    await this.setSecurity(agentId, next);
  }
}
