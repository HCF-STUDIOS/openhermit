import { randomUUID } from 'node:crypto';

import { drizzle } from 'drizzle-orm/node-postgres';
import { and, eq } from 'drizzle-orm';
import pg from 'pg';

import type { PolicyStore } from '../interfaces.js';
import type { PolicyEffect, PolicyRecord } from '../types.js';
import * as schema from '../schema.js';
import { agentPolicies } from '../schema.js';
import type { DrizzleDb } from './index.js';

export class DbPolicyStore implements PolicyStore {
  private pool?: pg.Pool;

  /**
   * In-flight `list` promises keyed by `agentId|resourceType` (or
   * `agentId|*` for "all types"). Concurrent callers within the same
   * tick share a single SELECT — this is the hot path during
   * `openSession`, where two parallel sessions on the same agent each
   * load 'tool' and 'mcp' policies. Cleared as soon as the promise
   * settles, so no staleness risk.
   */
  private readonly inFlightList = new Map<string, Promise<PolicyRecord[]>>();

  constructor(private readonly db: DrizzleDb) {}

  static async open(databaseUrl?: string): Promise<DbPolicyStore> {
    const url = databaseUrl ?? process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL environment variable is required');
    const pool = new pg.Pool({ connectionString: url });
    await pool.query('SELECT 1');
    const db = drizzle(pool, { schema });
    const store = new DbPolicyStore(db);
    store.pool = pool;
    return store;
  }

  async close(): Promise<void> {
    await this.pool?.end();
  }

  async list(agentId: string, resourceType?: string): Promise<PolicyRecord[]> {
    const key = `${agentId}|${resourceType ?? '*'}`;
    const existing = this.inFlightList.get(key);
    if (existing) return existing;

    const promise = this.runList(agentId, resourceType);
    this.inFlightList.set(key, promise);
    try {
      return await promise;
    } finally {
      this.inFlightList.delete(key);
    }
  }

  private async runList(agentId: string, resourceType?: string): Promise<PolicyRecord[]> {
    const conditions = resourceType
      ? and(eq(agentPolicies.agentId, agentId), eq(agentPolicies.resourceType, resourceType))
      : eq(agentPolicies.agentId, agentId);

    // One in-process retry: the SELECT itself is idempotent and the
    // reported failure mode was transient ("DrizzleQueryError" with no
    // schema mismatch). Cheaper than 500ing the caller.
    let lastErr: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const rows = await this.db.select().from(agentPolicies).where(conditions);
        return rows.map(toRecord);
      } catch (err) {
        lastErr = err;
        const cause = (err as { cause?: unknown }).cause;
        const code = (err as { code?: unknown }).code
          ?? (cause as { code?: unknown } | undefined)?.code;
        console.warn(
          `[policy-store] list(${agentId}, ${resourceType ?? '*'}) attempt ${attempt + 1} failed`,
          { code, cause: cause ?? err },
        );
      }
    }
    throw lastErr;
  }

  async get(
    agentId: string,
    resourceType: string,
    resourceKey: string,
    effect?: string,
  ): Promise<PolicyRecord | undefined> {
    const conditions = effect
      ? and(
          eq(agentPolicies.agentId, agentId),
          eq(agentPolicies.resourceType, resourceType),
          eq(agentPolicies.resourceKey, resourceKey),
          eq(agentPolicies.effect, effect),
        )
      : and(
          eq(agentPolicies.agentId, agentId),
          eq(agentPolicies.resourceType, resourceType),
          eq(agentPolicies.resourceKey, resourceKey),
        );

    const rows = await this.db
      .select()
      .from(agentPolicies)
      .where(conditions)
      .limit(1);

    return rows[0] ? toRecord(rows[0]) : undefined;
  }

  async upsert(
    input: Omit<PolicyRecord, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<PolicyRecord> {
    const now = new Date().toISOString();
    const existing = await this.get(input.agentId, input.resourceType, input.resourceKey, input.effect);

    if (existing) {
      await this.db
        .update(agentPolicies)
        .set({ grants: input.grants, scope: input.scope, updatedAt: now })
        .where(eq(agentPolicies.id, existing.id));
      return { ...existing, grants: input.grants, scope: input.scope, updatedAt: now };
    }

    const row = {
      id: randomUUID(),
      agentId: input.agentId,
      resourceType: input.resourceType,
      resourceKey: input.resourceKey,
      effect: input.effect,
      grants: input.grants,
      scope: input.scope,
      createdAt: now,
      updatedAt: now,
    };
    await this.db.insert(agentPolicies).values(row);
    return toRecord(row);
  }

  async delete(
    agentId: string,
    resourceType: string,
    resourceKey: string,
    effect?: string,
  ): Promise<void> {
    const conditions = effect
      ? and(
          eq(agentPolicies.agentId, agentId),
          eq(agentPolicies.resourceType, resourceType),
          eq(agentPolicies.resourceKey, resourceKey),
          eq(agentPolicies.effect, effect),
        )
      : and(
          eq(agentPolicies.agentId, agentId),
          eq(agentPolicies.resourceType, resourceType),
          eq(agentPolicies.resourceKey, resourceKey),
        );

    await this.db.delete(agentPolicies).where(conditions);
  }
}

function toRecord(row: typeof agentPolicies.$inferSelect): PolicyRecord {
  return {
    id: row.id,
    agentId: row.agentId,
    resourceType: row.resourceType,
    resourceKey: row.resourceKey,
    effect: (row.effect ?? 'allow') as PolicyEffect,
    grants: row.grants ?? [],
    scope: (row.scope ?? {}) as Record<string, unknown>,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
