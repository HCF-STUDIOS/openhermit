import { randomUUID } from 'node:crypto';
import { eq, and, sql } from 'drizzle-orm';

import type { MemoryProvider } from '../interfaces.js';
import type { MemoryAddInput, MemoryEntry, MemorySearchOptions, MemoryUpdateInput, StoreScope } from '../types.js';
import { memories } from '../schema.js';
import type { DrizzleDb } from './index.js';

export class DbMemoryProvider implements MemoryProvider {
  readonly name = 'db';
  private ftsReady = false;

  constructor(private readonly db: DrizzleDb) {}

  async initialize(_scope: StoreScope): Promise<void> {
    await this.ensureFts();
  }

  async shutdown(): Promise<void> {}

  private async ensureFts(): Promise<void> {
    if (this.ftsReady) return;
    try {
      await this.db.execute(sql`
        DO $$ BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'memories' AND column_name = 'content_tsv'
          ) THEN
            ALTER TABLE "memories" ADD COLUMN "content_tsv" tsvector
              GENERATED ALWAYS AS (to_tsvector('english', content)) STORED;
            CREATE INDEX IF NOT EXISTS "idx_memories_fts" ON "memories" USING gin("content_tsv");
          END IF;
        END $$
      `);
      this.ftsReady = true;
    } catch {
      // FTS setup failed — search will use fallback.
    }
  }

  async add(scope: StoreScope, input: MemoryAddInput): Promise<MemoryEntry> {
    const id = input.id?.trim() || `mem-${randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    const metadata = (input.metadata ?? {}) as Record<string, unknown>;
    const grants = input.grants ?? [];

    await this.db.insert(memories).values({
      agentId: scope.agentId,
      memoryKey: id,
      content: input.content,
      metadata,
      grants,
      createdAt: now,
      updatedAt: now,
    }).onConflictDoUpdate({
      target: [memories.agentId, memories.memoryKey],
      set: { content: input.content, metadata, grants, updatedAt: now },
    });

    return { id, content: input.content, metadata: input.metadata ?? {}, grants, createdAt: now, updatedAt: now };
  }

  async search(scope: StoreScope, query: string, options?: MemorySearchOptions): Promise<MemoryEntry[]> {
    const limit = Math.max(1, Math.min(50, options?.limit ?? 10));
    const trimmed = query.trim();
    if (!trimmed) return [];

    await this.ensureFts();

    type MemRow = {
      memory_key: string;
      content: string;
      metadata: unknown;
      grants: unknown;
      created_at: string;
      updated_at: string;
    };

    const toEntry = (row: MemRow): MemoryEntry => ({
      id: row.memory_key,
      content: row.content,
      metadata: (row.metadata ?? {}) as Record<string, unknown>,
      grants: (Array.isArray(row.grants) ? row.grants : []) as unknown[],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });

    const seen = new Set<string>();
    const results: MemoryEntry[] = [];
    const collect = (rows: MemRow[]) => {
      for (const row of rows) {
        if (seen.has(row.memory_key)) continue;
        seen.add(row.memory_key);
        results.push(toEntry(row));
      }
    };

    // 1) FTS with English stemming (handles stemming, ranking)
    if (this.ftsReady) {
      try {
        const fts = await this.db.execute<MemRow>(sql`
          SELECT m.memory_key, m.content, m.metadata, m.grants, m.created_at, m.updated_at
          FROM memories m
          WHERE m.agent_id = ${scope.agentId}
            AND m.content_tsv @@ plainto_tsquery('english', ${trimmed})
          ORDER BY ts_rank(m.content_tsv, plainto_tsquery('english', ${trimmed})) DESC
          LIMIT ${limit}
        `);
        collect(fts.rows);
      } catch { /* FTS column issue — continue to fallback */ }
    }

    // 2) Per-word ILIKE on both key and content (handles CJK, partial matches, key paths)
    if (results.length < limit) {
      const words = trimmed
        .split(/[\s/,;:]+/)
        .map(w => w.trim())
        .filter(w => w.length > 0);

      if (words.length > 0) {
        const conditions = words.map(w => {
          const pattern = `%${w}%`;
          return sql`(m.memory_key ILIKE ${pattern} OR m.content ILIKE ${pattern})`;
        });

        const combined = conditions.reduce((a, b) => sql`${a} OR ${b}`);
        const remaining = limit - results.length;
        const excludeKeys = results.map(r => r.id);

        let ilike;
        if (excludeKeys.length > 0) {
          const notIn = excludeKeys.map(k => sql`${k}`).reduce((a, b) => sql`${a}, ${b}`);
          ilike = await this.db.execute<MemRow>(sql`
            SELECT m.memory_key, m.content, m.metadata, m.grants, m.created_at, m.updated_at,
              (${words.map(w => {
                const p = `%${w}%`;
                return sql`(CASE WHEN m.memory_key ILIKE ${p} OR m.content ILIKE ${p} THEN 1 ELSE 0 END)`;
              }).reduce((a, b) => sql`${a} + ${b}`)}) as word_hits
            FROM memories m
            WHERE m.agent_id = ${scope.agentId}
              AND m.memory_key NOT IN (${notIn})
              AND (${combined})
            ORDER BY word_hits DESC, m.updated_at DESC
            LIMIT ${remaining}
          `);
        } else {
          ilike = await this.db.execute<MemRow>(sql`
            SELECT m.memory_key, m.content, m.metadata, m.grants, m.created_at, m.updated_at,
              (${words.map(w => {
                const p = `%${w}%`;
                return sql`(CASE WHEN m.memory_key ILIKE ${p} OR m.content ILIKE ${p} THEN 1 ELSE 0 END)`;
              }).reduce((a, b) => sql`${a} + ${b}`)}) as word_hits
            FROM memories m
            WHERE m.agent_id = ${scope.agentId}
              AND (${combined})
            ORDER BY word_hits DESC, m.updated_at DESC
            LIMIT ${remaining}
          `);
        }
        collect(ilike.rows);
      }
    }

    return results.slice(0, limit);
  }

  async list(scope: StoreScope, prefix: string, options?: { limit?: number }): Promise<MemoryEntry[]> {
    const limit = Math.max(1, Math.min(50, options?.limit ?? 20));
    const pattern = `${prefix}%`;
    const rows = await this.db.execute<{
      memory_key: string;
      content: string;
      metadata: unknown;
      grants: unknown;
      created_at: string;
      updated_at: string;
    }>(sql`
      SELECT memory_key, content, metadata, grants, created_at, updated_at
      FROM memories
      WHERE agent_id = ${scope.agentId}
        AND memory_key LIKE ${pattern}
      ORDER BY updated_at DESC
      LIMIT ${limit}
    `);
    return rows.rows.map((row) => ({
      id: row.memory_key,
      content: row.content,
      metadata: (row.metadata ?? {}) as Record<string, unknown>,
      grants: (Array.isArray(row.grants) ? row.grants : []) as unknown[],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  async get(scope: StoreScope, id: string): Promise<MemoryEntry | undefined> {
    const [row] = await this.db.select().from(memories)
      .where(and(eq(memories.agentId, scope.agentId), eq(memories.memoryKey, id)));
    if (!row) return undefined;
    return {
      id: row.memoryKey,
      content: row.content,
      metadata: (row.metadata ?? {}) as Record<string, unknown>,
      grants: (Array.isArray(row.grants) ? row.grants : []) as unknown[],
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  async update(scope: StoreScope, id: string, input: MemoryUpdateInput): Promise<MemoryEntry> {
    const existing = await this.get(scope, id);
    if (!existing) throw new Error(`Memory entry not found: ${id}`);

    const content = input.content ?? existing.content;
    const metadata = input.metadata !== undefined ? { ...existing.metadata, ...input.metadata } : existing.metadata;
    const grants = input.grants !== undefined ? input.grants : existing.grants;
    const now = new Date().toISOString();

    await this.db.update(memories).set({
      content,
      metadata: (metadata ?? {}) as Record<string, unknown>,
      grants,
      updatedAt: now,
    }).where(and(eq(memories.agentId, scope.agentId), eq(memories.memoryKey, id)));

    return { id, content, metadata, grants, createdAt: existing.createdAt, updatedAt: now };
  }

  async delete(scope: StoreScope, id: string): Promise<void> {
    await this.db.delete(memories)
      .where(and(eq(memories.agentId, scope.agentId), eq(memories.memoryKey, id)));
  }
}
