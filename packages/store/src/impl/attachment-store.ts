import { randomUUID } from 'node:crypto';

import { drizzle } from 'drizzle-orm/node-postgres';
import { and, desc, eq } from 'drizzle-orm';
import pg from 'pg';

import type { AttachmentStore } from '../interfaces.js';
import type {
  AttachmentCreateInput,
  AttachmentListOptions,
  AttachmentMaterializationPatch,
  AttachmentMaterializationState,
  AttachmentRecord,
  StoreScope,
} from '../types.js';
import * as schema from '../schema.js';
import { sessionAttachments } from '../schema.js';
import type { DrizzleDb } from './index.js';

export class DbAttachmentStore implements AttachmentStore {
  private pool?: pg.Pool;

  constructor(private readonly db: DrizzleDb) {}

  static async open(databaseUrl?: string): Promise<DbAttachmentStore> {
    const url = databaseUrl ?? process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL environment variable is required');
    const pool = new pg.Pool({ connectionString: url });
    await pool.query('SELECT 1');
    const db = drizzle(pool, { schema });
    const store = new DbAttachmentStore(db);
    store.pool = pool;
    return store;
  }

  async close(): Promise<void> {
    await this.pool?.end();
  }

  async create(input: AttachmentCreateInput): Promise<AttachmentRecord> {
    const row = {
      id: input.id ?? `att_${randomUUID()}`,
      agentId: input.agentId,
      sessionId: input.sessionId,
      uploaderUserId: input.uploaderUserId ?? null,
      originalName: input.originalName,
      safeName: input.safeName,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
      sha256: input.sha256,
      storageProvider: input.storageProvider,
      storageKey: input.storageKey,
      sandboxId: null,
      sandboxPath: null,
      materializationState: 'pending' as const,
      materializationError: null,
      createdAt: new Date().toISOString(),
    };
    const [inserted] = await this.db.insert(sessionAttachments).values(row).returning();
    if (!inserted) throw new Error('attachment insert returned no row');
    return toRecord(inserted);
  }

  async get(id: string): Promise<AttachmentRecord | undefined> {
    const rows = await this.db
      .select()
      .from(sessionAttachments)
      .where(eq(sessionAttachments.id, id))
      .limit(1);
    return rows[0] ? toRecord(rows[0]) : undefined;
  }

  async list(
    scope: StoreScope,
    sessionId: string,
    options: AttachmentListOptions = {},
  ): Promise<AttachmentRecord[]> {
    const scopeKind = options.scope ?? 'session';
    const limit = options.limit ?? 100;

    let where;
    if (scopeKind === 'user') {
      // User-scoped listing requires a user id; cross-user listing is
      // never permitted, even within the same agent.
      if (!options.userId) {
        throw new Error('AttachmentStore.list with scope=user requires options.userId');
      }
      where = and(
        eq(sessionAttachments.agentId, scope.agentId),
        eq(sessionAttachments.uploaderUserId, options.userId),
      );
    } else {
      where = and(
        eq(sessionAttachments.agentId, scope.agentId),
        eq(sessionAttachments.sessionId, sessionId),
      );
    }

    const rows = await this.db
      .select()
      .from(sessionAttachments)
      .where(where)
      .orderBy(desc(sessionAttachments.createdAt))
      .limit(limit);
    return rows.map(toRecord);
  }

  async setMaterialization(
    id: string,
    patch: AttachmentMaterializationPatch,
  ): Promise<void> {
    const update: Partial<typeof sessionAttachments.$inferInsert> = {
      materializationState: patch.state,
    };
    if (patch.sandboxId !== undefined) update.sandboxId = patch.sandboxId;
    if (patch.sandboxPath !== undefined) update.sandboxPath = patch.sandboxPath;
    if (patch.error !== undefined) update.materializationError = patch.error;
    await this.db
      .update(sessionAttachments)
      .set(update)
      .where(eq(sessionAttachments.id, id));
  }

  async delete(id: string): Promise<void> {
    await this.db.delete(sessionAttachments).where(eq(sessionAttachments.id, id));
  }
}

function toRecord(row: typeof sessionAttachments.$inferSelect): AttachmentRecord {
  return {
    id: row.id,
    agentId: row.agentId,
    sessionId: row.sessionId,
    uploaderUserId: row.uploaderUserId,
    originalName: row.originalName,
    safeName: row.safeName,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    sha256: row.sha256,
    storageProvider: row.storageProvider,
    storageKey: row.storageKey,
    sandboxId: row.sandboxId,
    sandboxPath: row.sandboxPath,
    materializationState: row.materializationState as AttachmentMaterializationState,
    materializationError: row.materializationError,
    createdAt: row.createdAt,
  };
}
