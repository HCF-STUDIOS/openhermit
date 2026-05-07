import { randomUUID } from 'node:crypto';

import { drizzle } from 'drizzle-orm/node-postgres';
import { and, eq, lt } from 'drizzle-orm';
import pg from 'pg';

import type { ApprovalRequestStore } from '../interfaces.js';
import type {
  ApprovalRequestCreateInput,
  ApprovalRequestRecord,
  ApprovalResolution,
  ApprovalStatus,
} from '../types.js';
import * as schema from '../schema.js';
import { approvalRequests } from '../schema.js';
import type { DrizzleDb } from './index.js';

export class DbApprovalRequestStore implements ApprovalRequestStore {
  private pool?: pg.Pool;

  constructor(private readonly db: DrizzleDb) {}

  static async open(databaseUrl?: string): Promise<DbApprovalRequestStore> {
    const url = databaseUrl ?? process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL environment variable is required');
    const pool = new pg.Pool({ connectionString: url });
    await pool.query('SELECT 1');
    const db = drizzle(pool, { schema });
    const store = new DbApprovalRequestStore(db);
    store.pool = pool;
    return store;
  }

  async close(): Promise<void> {
    await this.pool?.end();
  }

  async create(input: ApprovalRequestCreateInput): Promise<ApprovalRequestRecord> {
    const now = new Date().toISOString();
    const row = {
      id: randomUUID(),
      agentId: input.agentId,
      sessionId: input.sessionId,
      requesterId: input.requesterId,
      resourceType: input.resourceType,
      resourceKey: input.resourceKey,
      scope: input.scope ?? {},
      status: 'pending' as const,
      resolution: null,
      resolvedBy: null,
      reason: null,
      createdAt: now,
      resolvedAt: null,
      ttlMinutes: input.ttlMinutes ?? 60,
    };
    const [inserted] = await this.db.insert(approvalRequests).values(row).returning();
    if (!inserted) throw new Error('approval request insert returned no row');
    return toRecord(inserted);
  }

  async get(id: string): Promise<ApprovalRequestRecord | undefined> {
    const rows = await this.db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.id, id))
      .limit(1);
    return rows[0] ? toRecord(rows[0]) : undefined;
  }

  async getByShortId(shortId: number): Promise<ApprovalRequestRecord | undefined> {
    const rows = await this.db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.shortId, shortId))
      .limit(1);
    return rows[0] ? toRecord(rows[0]) : undefined;
  }

  async list(agentId: string, status?: ApprovalStatus): Promise<ApprovalRequestRecord[]> {
    const conditions = status
      ? and(eq(approvalRequests.agentId, agentId), eq(approvalRequests.status, status))
      : eq(approvalRequests.agentId, agentId);
    const rows = await this.db.select().from(approvalRequests).where(conditions);
    return rows.map(toRecord);
  }

  async findApproved(
    agentId: string,
    requesterId: string,
    resourceType: string,
    resourceKey: string,
  ): Promise<ApprovalRequestRecord | undefined> {
    const rows = await this.db
      .select()
      .from(approvalRequests)
      .where(
        and(
          eq(approvalRequests.agentId, agentId),
          eq(approvalRequests.requesterId, requesterId),
          eq(approvalRequests.resourceType, resourceType),
          eq(approvalRequests.resourceKey, resourceKey),
          eq(approvalRequests.status, 'approved'),
        ),
      )
      .limit(1);
    if (!rows[0]) return undefined;
    const record = toRecord(rows[0]);
    if (isExpired(record)) return undefined;
    return record;
  }

  async resolve(
    id: string,
    decision: 'approved' | 'rejected',
    resolvedBy: string,
    resolution?: ApprovalResolution,
    reason?: string,
  ): Promise<ApprovalRequestRecord> {
    const now = new Date().toISOString();
    await this.db
      .update(approvalRequests)
      .set({
        status: decision,
        resolvedBy,
        resolution: resolution ?? (decision === 'approved' ? 'once' : null),
        reason: reason ?? null,
        resolvedAt: now,
      })
      .where(eq(approvalRequests.id, id));
    const updated = await this.get(id);
    if (!updated) throw new Error(`Approval request ${id} not found after update`);
    return updated;
  }

  async expireOld(): Promise<number> {
    const now = new Date();
    const pending = await this.db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.status, 'pending'));

    let count = 0;
    for (const row of pending) {
      const created = new Date(row.createdAt);
      const expiresAt = new Date(created.getTime() + (row.ttlMinutes ?? 60) * 60_000);
      if (now > expiresAt) {
        await this.db
          .update(approvalRequests)
          .set({ status: 'expired', resolvedAt: now.toISOString() })
          .where(eq(approvalRequests.id, row.id));
        count++;
      }
    }
    return count;
  }
}

function isExpired(record: ApprovalRequestRecord): boolean {
  if (record.resolution === 'persistent') return false;
  const created = new Date(record.createdAt);
  const expiresAt = new Date(created.getTime() + record.ttlMinutes * 60_000);
  return new Date() > expiresAt;
}

function toRecord(row: typeof approvalRequests.$inferSelect): ApprovalRequestRecord {
  return {
    id: row.id,
    shortId: Number(row.shortId),
    agentId: row.agentId,
    sessionId: row.sessionId,
    requesterId: row.requesterId,
    resourceType: row.resourceType,
    resourceKey: row.resourceKey,
    scope: (row.scope ?? {}) as Record<string, unknown>,
    status: (row.status ?? 'pending') as ApprovalStatus,
    resolution: row.resolution as ApprovalResolution | null,
    resolvedBy: row.resolvedBy,
    reason: row.reason,
    createdAt: row.createdAt,
    resolvedAt: row.resolvedAt,
    ttlMinutes: row.ttlMinutes ?? 60,
  };
}
