import { drizzle } from 'drizzle-orm/node-postgres';
import { eq, and, ne, lt, desc, sql } from 'drizzle-orm';
import pg from 'pg';
import type { MetadataValue, SessionStatus, SessionType } from '@openhermit/protocol';

import type { SessionStore } from '../interfaces.js';
import type { PersistedSessionIndexEntry, StoreScope } from '../types.js';
import * as schema from '../schema.js';
import { sessionEvents, sessions } from '../schema.js';
import type { DrizzleDb } from './index.js';

export class DbSessionStore implements SessionStore {
  private pool?: pg.Pool;

  constructor(private readonly db: DrizzleDb) {}

  static async open(databaseUrl?: string): Promise<DbSessionStore> {
    const url = databaseUrl ?? process.env.DATABASE_URL;
    if (!url) {
      throw new Error('DATABASE_URL environment variable is required');
    }
    const pool = new pg.Pool({ connectionString: url });
    await pool.query('SELECT 1');
    const db = drizzle(pool, { schema });
    const store = new DbSessionStore(db);
    store.pool = pool;
    return store;
  }

  async close(): Promise<void> {
    await this.pool?.end();
  }

  async waitForIdle(): Promise<void> {}

  async list(scope: StoreScope, options?: { userId?: string; includeInactive?: boolean }): Promise<PersistedSessionIndexEntry[]> {
    const conditions = [eq(sessions.agentId, scope.agentId)];
    if (!options?.includeInactive) {
      conditions.push(ne(sessions.status, 'inactive'));
    }
    if (options?.userId) {
      // jsonb @> jsonb : "user_ids contains [userId]". Backed by the
      // gin index on sessions.user_ids — no client-side filter.
      conditions.push(sql`${sessions.userIds} @> ${JSON.stringify([options.userId])}::jsonb`);
    }

    const rows = await this.db.select().from(sessions)
      .where(and(...conditions))
      .orderBy(desc(sessions.lastActivityAt));

    return rows.map((row) => this.rowToEntry(row));
  }

  async get(scope: StoreScope, sessionId: string): Promise<PersistedSessionIndexEntry | undefined> {
    const [row] = await this.db.select().from(sessions)
      .where(and(eq(sessions.agentId, scope.agentId), eq(sessions.sessionId, sessionId)));
    return row ? this.rowToEntry(row) : undefined;
  }

  async upsert(scope: StoreScope, entry: PersistedSessionIndexEntry): Promise<void> {
    // Identity / classification fields are written ONCE at session creation
    // and must never be overwritten by later runtime updates — runtime
    // memory caches them, and a stale cache (e.g. a session reopened from
    // a different channel) used to corrupt DB on conflict.
    const immutable = {
      sourceKind: entry.source.kind,
      sourcePlatform: entry.source.platform ?? null,
      interactive: entry.source.interactive ? 1 : 0,
      createdAt: entry.createdAt,
      type: entry.type ?? entry.source.type ?? 'direct',
      customInstruction: entry.customInstruction ?? null,
    };
    // Runtime-mutable fields — re-written every persistSessionIndex.
    const runtime = {
      lastActivityAt: entry.lastActivityAt,
      description: entry.description ?? null,
      descriptionSource: entry.descriptionSource ?? null,
      messageCount: entry.messageCount,
      completedTurnCount: entry.completedTurnCount ?? 0,
      lastMessagePreview: entry.lastMessagePreview ?? null,
      metadata: entry.metadata ?? {},
      status: entry.status ?? 'idle',
      userIds: entry.userIds ?? [],
    };

    await this.db.insert(sessions).values({
      agentId: scope.agentId,
      sessionId: entry.sessionId,
      ...immutable,
      ...runtime,
    }).onConflictDoUpdate({
      target: [sessions.agentId, sessions.sessionId],
      set: runtime,
    });
  }

  async updateDescription(scope: StoreScope, sessionId: string, description: string, source: 'fallback' | 'ai'): Promise<void> {
    await this.db.update(sessions).set({ description, descriptionSource: source })
      .where(and(eq(sessions.agentId, scope.agentId), eq(sessions.sessionId, sessionId)));
  }

  async updateStatus(scope: StoreScope, sessionId: string, status: string): Promise<void> {
    await this.db.update(sessions).set({ status })
      .where(and(eq(sessions.agentId, scope.agentId), eq(sessions.sessionId, sessionId)));
  }

  async delete(scope: StoreScope, sessionId: string): Promise<void> {
    const where = and(eq(sessions.agentId, scope.agentId), eq(sessions.sessionId, sessionId));
    await this.db.delete(sessionEvents)
      .where(and(eq(sessionEvents.agentId, scope.agentId), eq(sessionEvents.sessionId, sessionId)));
    await this.db.delete(sessions).where(where);
  }

  async markStaleInactive(scope: StoreScope, olderThanIso: string): Promise<number> {
    const result = await this.db.update(sessions).set({ status: 'inactive' })
      .where(and(
        eq(sessions.agentId, scope.agentId),
        ne(sessions.status, 'inactive'),
        lt(sessions.lastActivityAt, olderThanIso),
      ))
      .returning();
    return result.length;
  }

  private rowToEntry(row: typeof sessions.$inferSelect): PersistedSessionIndexEntry {
    const metadata = (row.metadata ?? {}) as Record<string, unknown>;
    const entry: PersistedSessionIndexEntry = {
      sessionId: row.sessionId,
      source: {
        kind: row.sourceKind,
        interactive: row.interactive === 1,
        ...(row.sourcePlatform !== null ? { platform: row.sourcePlatform } : {}),
        ...(row.type !== 'direct' ? { type: row.type as SessionType } : {}),
      },
      status: row.status as SessionStatus,
      createdAt: row.createdAt,
      lastActivityAt: row.lastActivityAt,
      messageCount: row.messageCount,
      completedTurnCount: row.completedTurnCount,
      ...(row.type !== 'direct' ? { type: row.type as SessionType } : {}),
    };

    if (row.description !== null) entry.description = row.description;
    if (row.descriptionSource === 'fallback' || row.descriptionSource === 'ai') {
      entry.descriptionSource = row.descriptionSource;
    }
    if (row.lastMessagePreview !== null) entry.lastMessagePreview = row.lastMessagePreview;
    if (Object.keys(metadata).length > 0) entry.metadata = metadata as Record<string, MetadataValue>;

    const userIds = (row.userIds ?? []) as string[];
    if (userIds.length > 0) entry.userIds = userIds;

    if (row.customInstruction !== null && row.customInstruction !== undefined) {
      entry.customInstruction = row.customInstruction;
    }

    return entry;
  }
}
