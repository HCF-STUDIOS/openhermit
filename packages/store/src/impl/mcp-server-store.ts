import { drizzle } from 'drizzle-orm/node-postgres';
import { eq, and, inArray, asc } from 'drizzle-orm';
import pg from 'pg';
import { createStorePool } from './pool.js';

import type { McpServerStore } from '../interfaces.js';
import type { AgentMcpServerRecord, McpServerRecord } from '../types.js';
import * as schema from '../schema.js';
import { mcpServers, agentMcpServers } from '../schema.js';
import type { DrizzleDb } from './index.js';

export class DbMcpServerStore implements McpServerStore {
  private pool?: pg.Pool;

  constructor(private readonly db: DrizzleDb) {}

  static async open(databaseUrl?: string): Promise<DbMcpServerStore> {
    const url = databaseUrl ?? process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL environment variable is required');
    const pool = createStorePool(url);
    await pool.query('SELECT 1');
    const db = drizzle(pool, { schema });
    const store = new DbMcpServerStore(db);
    store.pool = pool;
    return store;
  }

  async close(): Promise<void> {
    await this.pool?.end();
  }

  async upsert(server: McpServerRecord): Promise<void> {
    const data = {
      name: server.name,
      description: server.description,
      url: server.url,
      headers: (server.headers ?? {}) as Record<string, string>,
      metadata: (server.metadata ?? {}) as Record<string, unknown>,
      createdAt: server.createdAt,
      updatedAt: server.updatedAt,
    };
    await this.db.insert(mcpServers).values({ id: server.id, ...data })
      .onConflictDoUpdate({ target: mcpServers.id, set: data });
  }

  async get(id: string): Promise<McpServerRecord | undefined> {
    const [row] = await this.db.select().from(mcpServers).where(eq(mcpServers.id, id));
    if (!row) return undefined;
    return this.rowToRecord(row);
  }

  async list(): Promise<McpServerRecord[]> {
    const rows = await this.db.select().from(mcpServers).orderBy(asc(mcpServers.name));
    return rows.map((r) => this.rowToRecord(r));
  }

  async delete(id: string): Promise<void> {
    await this.db.delete(agentMcpServers).where(eq(agentMcpServers.mcpServerId, id)).catch(() => undefined);
    await this.db.delete(mcpServers).where(eq(mcpServers.id, id)).catch(() => undefined);
  }

  async enable(agentId: string, mcpServerId: string): Promise<void> {
    const now = new Date().toISOString();
    await this.db.insert(agentMcpServers)
      .values({ agentId, mcpServerId, enabled: true, createdAt: now })
      .onConflictDoUpdate({
        target: [agentMcpServers.agentId, agentMcpServers.mcpServerId],
        set: { enabled: true },
      });
  }

  async disable(agentId: string, mcpServerId: string): Promise<void> {
    await this.db.update(agentMcpServers).set({ enabled: false })
      .where(and(eq(agentMcpServers.agentId, agentId), eq(agentMcpServers.mcpServerId, mcpServerId)))
      .catch(() => undefined);
  }

  async listEnabled(agentId: string): Promise<McpServerRecord[]> {
    const rows = await this.db.select({
      mcpServerId: agentMcpServers.mcpServerId,
      id: mcpServers.id,
      name: mcpServers.name,
      description: mcpServers.description,
      url: mcpServers.url,
      headers: mcpServers.headers,
      metadata: mcpServers.metadata,
      createdAt: mcpServers.createdAt,
      updatedAt: mcpServers.updatedAt,
    }).from(agentMcpServers)
      .innerJoin(mcpServers, eq(agentMcpServers.mcpServerId, mcpServers.id))
      .where(and(
        inArray(agentMcpServers.agentId, [agentId, '*']),
        eq(agentMcpServers.enabled, true),
      ));

    const seen = new Set<string>();
    const result: McpServerRecord[] = [];
    for (const row of rows) {
      if (!seen.has(row.mcpServerId)) {
        seen.add(row.mcpServerId);
        result.push(this.rowToRecord(row));
      }
    }
    return result.sort((a, b) => a.name.localeCompare(b.name));
  }

  async listAssignments(mcpServerId?: string): Promise<AgentMcpServerRecord[]> {
    const q = mcpServerId
      ? this.db.select().from(agentMcpServers).where(eq(agentMcpServers.mcpServerId, mcpServerId))
      : this.db.select().from(agentMcpServers);
    const rows = await q;
    return rows.map((r) => ({
      agentId: r.agentId,
      mcpServerId: r.mcpServerId,
      enabled: r.enabled,
      createdAt: r.createdAt,
    }));
  }

  private rowToRecord(row: {
    id: string;
    name: string;
    description: string;
    url: string;
    headers: unknown;
    metadata: unknown;
    createdAt: string;
    updatedAt: string;
  }): McpServerRecord {
    const headers = (row.headers ?? {}) as Record<string, string>;
    const metadata = (row.metadata ?? {}) as Record<string, unknown>;
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      url: row.url,
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
      ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
