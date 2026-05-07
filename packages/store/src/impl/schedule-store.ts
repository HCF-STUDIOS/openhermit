import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq, and, desc, isNull, sql } from 'drizzle-orm';
import pg from 'pg';

import type { ScheduleStore } from '../interfaces.js';
import type {
  ScheduleCreateInput,
  ScheduleDelivery,
  SchedulePolicy,
  ScheduleRecord,
  ScheduleRunRecord,
  ScheduleRunStatus,
  ScheduleStatus,
  ScheduleType,
  ScheduleUpdateInput,
  StoreScope,
} from '../types.js';
import * as schema from '../schema.js';
import { schedules, scheduleRuns } from '../schema.js';
import type { DrizzleDb } from './index.js';

export class DbScheduleStore implements ScheduleStore {
  constructor(private readonly db: DrizzleDb) {}

  static async open(databaseUrl?: string): Promise<DbScheduleStore> {
    const url = databaseUrl ?? process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL environment variable is required');
    const pool = new pg.Pool({ connectionString: url });
    await pool.query('SELECT 1');
    const db = drizzle(pool, { schema });
    return new DbScheduleStore(db);
  }

  async close(): Promise<void> {}

  async create(scope: StoreScope, input: ScheduleCreateInput): Promise<ScheduleRecord> {
    const now = new Date().toISOString();
    const scheduleId = input.scheduleId ?? randomUUID().slice(0, 8);
    const delivery: ScheduleDelivery = input.delivery ?? { kind: 'silent' };
    const policy = input.policy ?? {};
    const nextRunAt = input.type === 'once' ? (input.runAt ?? null) : null;

    const [row] = await this.db.insert(schedules).values({
      agentId: scope.agentId,
      scheduleId,
      type: input.type,
      status: 'active',
      cronExpression: input.cronExpression ?? null,
      runAt: input.runAt ?? null,
      prompt: input.prompt,
      sessionMode: JSON.stringify({ kind: 'dedicated' }),
      delivery: delivery as unknown,
      policy: policy as Record<string, unknown>,
      createdBy: input.createdBy ?? null,
      createdAt: now,
      updatedAt: now,
      nextRunAt,
      runCount: 0,
      consecutiveErrors: 0,
    }).returning();

    return this.rowToRecord(row!);
  }

  async get(scope: StoreScope, scheduleId: string): Promise<ScheduleRecord | undefined> {
    const [row] = await this.db.select().from(schedules)
      .where(and(eq(schedules.agentId, scope.agentId), eq(schedules.scheduleId, scheduleId)));
    if (!row) return undefined;
    return this.rowToRecord(row);
  }

  async list(scope: StoreScope, options?: { status?: string }): Promise<ScheduleRecord[]> {
    const conditions = [eq(schedules.agentId, scope.agentId)];
    if (options?.status) conditions.push(eq(schedules.status, options.status));

    const rows = await this.db.select().from(schedules)
      .where(and(...conditions))
      .orderBy(desc(schedules.createdAt));
    return rows.map((r) => this.rowToRecord(r));
  }

  async listAll(options?: { status?: string }): Promise<ScheduleRecord[]> {
    const conditions = [];
    if (options?.status) conditions.push(eq(schedules.status, options.status));

    const rows = await this.db.select().from(schedules)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(schedules.createdAt));
    return rows.map((r) => this.rowToRecord(r));
  }

  async listDue(scope: StoreScope, now: string): Promise<ScheduleRecord[]> {
    const rows = await this.db.select().from(schedules)
      .where(and(
        eq(schedules.agentId, scope.agentId),
        eq(schedules.status, 'active'),
        sql`${schedules.nextRunAt} <= ${now}`,
      ));
    return rows.map((r) => this.rowToRecord(r));
  }

  async listAllDue(now: string): Promise<ScheduleRecord[]> {
    const rows = await this.db.select().from(schedules)
      .where(and(
        eq(schedules.status, 'active'),
        sql`${schedules.nextRunAt} <= ${now}`,
      ));
    return rows.map((r) => this.rowToRecord(r));
  }

  async listAllOrphanedCron(): Promise<ScheduleRecord[]> {
    const rows = await this.db.select().from(schedules)
      .where(and(
        eq(schedules.status, 'active'),
        eq(schedules.type, 'cron'),
        isNull(schedules.nextRunAt),
      ));
    return rows.map((r) => this.rowToRecord(r));
  }

  async update(scope: StoreScope, scheduleId: string, input: ScheduleUpdateInput): Promise<ScheduleRecord> {
    const now = new Date().toISOString();
    const data: Record<string, unknown> = { updatedAt: now };
    if (input.status !== undefined) data.status = input.status;
    if (input.cronExpression !== undefined) {
      data.cronExpression = input.cronExpression;
      // Force recompute by central scheduler on next tick.
      data.nextRunAt = null;
    }
    if (input.runAt !== undefined) {
      data.runAt = input.runAt;
      data.nextRunAt = input.runAt;
    }
    if (input.prompt !== undefined) data.prompt = input.prompt;
    if (input.delivery !== undefined) data.delivery = input.delivery;
    if (input.policy !== undefined) data.policy = input.policy;

    const [row] = await this.db.update(schedules).set(data)
      .where(and(eq(schedules.agentId, scope.agentId), eq(schedules.scheduleId, scheduleId)))
      .returning();
    return this.rowToRecord(row!);
  }

  async delete(scope: StoreScope, scheduleId: string): Promise<void> {
    await this.db.delete(schedules)
      .where(and(eq(schedules.agentId, scope.agentId), eq(schedules.scheduleId, scheduleId)))
      .catch(() => undefined);
  }

  async markRun(scope: StoreScope, scheduleId: string, nextRunAt: string | null, error?: string): Promise<void> {
    const now = new Date().toISOString();
    const where = and(eq(schedules.agentId, scope.agentId), eq(schedules.scheduleId, scheduleId));

    if (error) {
      await this.db.update(schedules).set({
        lastRunAt: now,
        nextRunAt,
        consecutiveErrors: sql`${schedules.consecutiveErrors} + 1`,
        lastError: error,
        updatedAt: now,
      }).where(where);
    } else {
      await this.db.update(schedules).set({
        lastRunAt: now,
        nextRunAt,
        runCount: sql`${schedules.runCount} + 1`,
        consecutiveErrors: 0,
        lastError: null,
        updatedAt: now,
      }).where(where);
    }
  }

  async setNextRun(scope: StoreScope, scheduleId: string, nextRunAt: string | null): Promise<void> {
    await this.db.update(schedules).set({
      nextRunAt,
      updatedAt: new Date().toISOString(),
    }).where(and(eq(schedules.agentId, scope.agentId), eq(schedules.scheduleId, scheduleId)));
  }

  async startRun(scope: StoreScope, scheduleId: string, sessionId: string, prompt: string): Promise<ScheduleRunRecord> {
    const now = new Date().toISOString();
    const [row] = await this.db.insert(scheduleRuns).values({
      agentId: scope.agentId,
      scheduleId,
      status: 'running',
      sessionId,
      prompt,
      startedAt: now,
    }).returning();
    return this.runRowToRecord(row!);
  }

  async finishRun(scope: StoreScope, runId: number, status: 'completed' | 'failed', error?: string): Promise<ScheduleRunRecord> {
    const now = new Date().toISOString();
    const [existing] = await this.db.select().from(scheduleRuns).where(eq(scheduleRuns.id, runId));
    const startedAt = existing?.startedAt ?? now;
    const durationMs = new Date(now).getTime() - new Date(startedAt).getTime();

    const [row] = await this.db.update(scheduleRuns).set({
      status,
      finishedAt: now,
      durationMs,
      ...(error ? { error } : {}),
    }).where(eq(scheduleRuns.id, runId)).returning();
    return this.runRowToRecord(row!);
  }

  async listRuns(scope: StoreScope, scheduleId: string, limit = 20): Promise<ScheduleRunRecord[]> {
    const rows = await this.db.select().from(scheduleRuns)
      .where(and(eq(scheduleRuns.agentId, scope.agentId), eq(scheduleRuns.scheduleId, scheduleId)))
      .orderBy(desc(scheduleRuns.startedAt))
      .limit(limit);
    return rows.map((r) => this.runRowToRecord(r));
  }

  private runRowToRecord(row: typeof scheduleRuns.$inferSelect): ScheduleRunRecord {
    return {
      id: row.id,
      agentId: row.agentId,
      scheduleId: row.scheduleId,
      status: row.status as ScheduleRunStatus,
      ...(row.sessionId ? { sessionId: row.sessionId } : {}),
      prompt: row.prompt,
      startedAt: row.startedAt,
      ...(row.finishedAt ? { finishedAt: row.finishedAt } : {}),
      ...(row.durationMs != null ? { durationMs: row.durationMs } : {}),
      ...(row.error ? { error: row.error } : {}),
    };
  }

  private rowToRecord(row: typeof schedules.$inferSelect): ScheduleRecord {
    return {
      agentId: row.agentId,
      scheduleId: row.scheduleId,
      type: row.type as ScheduleType,
      status: row.status as ScheduleStatus,
      ...(row.cronExpression ? { cronExpression: row.cronExpression } : {}),
      ...(row.runAt ? { runAt: row.runAt } : {}),
      prompt: row.prompt,
      delivery: (row.delivery ?? { kind: 'silent' }) as ScheduleDelivery,
      policy: (row.policy ?? {}) as SchedulePolicy,
      ...(row.createdBy ? { createdBy: row.createdBy } : {}),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      ...(row.lastRunAt ? { lastRunAt: row.lastRunAt } : {}),
      ...(row.nextRunAt ? { nextRunAt: row.nextRunAt } : {}),
      runCount: row.runCount,
      consecutiveErrors: row.consecutiveErrors,
      ...(row.lastError ? { lastError: row.lastError } : {}),
    };
  }
}
