import { drizzle } from 'drizzle-orm/node-postgres';
import { and, eq, gt, inArray, sql } from 'drizzle-orm';
import pg from 'pg';

import type { AgentStore } from '../interfaces.js';
import type { AgentRecord, AgentStatus } from '../types.js';

export interface UsageWindow {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
}

export interface FleetUsageEntry {
  window24h: UsageWindow;
  window7d: UsageWindow;
  allTime: UsageWindow;
}

export interface FleetUsageWindows {
  window24h: UsageWindow;
  window7d: UsageWindow;
}

export interface AgentUsageDetail {
  totals: FleetUsageEntry;
  byModel: Array<{
    model: string;
    provider?: string;
    calls: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
  }>;
  daily: Array<{ day: string; inputTokens: number; outputTokens: number; costUsd: number }>;
}
import * as schema from '../schema.js';
import {
  agents,
  agentChannels,
  agentSecrets,
  agentSkills,
  agentMcpServers,
  sandboxes,
  instructions,
  memories,
  schedules,
  scheduleRuns,
  users,
  userAgents,
  sessions,
  sessionEvents,
} from '../schema.js';
import type { DrizzleDb } from './index.js';

export class DbAgentStore implements AgentStore {
  private pool?: pg.Pool;

  private constructor(private readonly db: DrizzleDb) {}

  static async open(databaseUrl?: string): Promise<DbAgentStore> {
    const url = databaseUrl ?? process.env.DATABASE_URL;
    if (!url) {
      throw new Error('DATABASE_URL environment variable is required');
    }
    const pool = new pg.Pool({ connectionString: url });
    await pool.query('SELECT 1');
    const db = drizzle(pool, { schema });
    const store = new DbAgentStore(db);
    store.pool = pool;
    return store;
  }

  async close(): Promise<void> {
    await this.pool?.end();
  }

  async create(agent: AgentRecord): Promise<AgentRecord> {
    const [row] = await this.db.insert(agents).values({
      agentId: agent.agentId,
      name: agent.name ?? null,
      workspaceDir: agent.workspaceDir,
      status: agent.status,
      createdAt: agent.createdAt,
      updatedAt: agent.updatedAt,
    }).returning();
    return this.toRecord(row!);
  }

  async get(agentId: string): Promise<AgentRecord | undefined> {
    const [row] = await this.db.select().from(agents).where(eq(agents.agentId, agentId));
    return row ? this.toRecord(row) : undefined;
  }

  async list(): Promise<AgentRecord[]> {
    const rows = await this.db.select().from(agents).orderBy(agents.createdAt);
    return rows.map((row) => this.toRecord(row));
  }

  async update(
    agentId: string,
    patch: Partial<Pick<AgentRecord, 'name' | 'workspaceDir'>>,
  ): Promise<AgentRecord | undefined> {
    const data: Record<string, unknown> = { updatedAt: new Date().toISOString() };
    if (patch.name !== undefined) data.name = patch.name ?? null;
    if (patch.workspaceDir !== undefined) data.workspaceDir = patch.workspaceDir;

    const rows = await this.db.update(agents).set(data).where(eq(agents.agentId, agentId)).returning();
    return rows[0] ? this.toRecord(rows[0]) : undefined;
  }

  async setStatus(agentId: string, status: AgentStatus): Promise<AgentRecord | undefined> {
    const rows = await this.db.update(agents)
      .set({ status, updatedAt: new Date().toISOString() })
      .where(eq(agents.agentId, agentId))
      .returning();
    return rows[0] ? this.toRecord(rows[0]) : undefined;
  }

  async seedInstructions(
    agentId: string,
    entries: Array<{ key: string; content: string }>,
    updatedAt: string,
  ): Promise<void> {
    if (entries.length === 0) return;
    await this.db.insert(instructions)
      .values(entries.map((e) => ({ agentId, key: e.key, content: e.content, updatedAt })))
      .onConflictDoNothing();
  }

  async assignOwner(agentId: string, userId: string, now: string): Promise<void> {
    await this.db.insert(users)
      .values({ userId, createdAt: now, updatedAt: now })
      .onConflictDoNothing();
    await this.db.insert(userAgents)
      .values({ userId, agentId, role: 'owner', createdAt: now })
      .onConflictDoUpdate({
        target: [userAgents.userId, userAgents.agentId],
        set: { role: 'owner' },
      });
  }

  /**
   * Aggregate per-agent stats for the fleet overview. One query per metric;
   * the result is keyed by agentId. `agentIds` is the set of agents to
   * include; the function also includes wildcard rows (`agent_id = '*'`)
   * when computing skill/MCP counts so wildcard assignments are reflected.
   *
   * `since` is an ISO timestamp; events older than that are not counted.
   */
  async fleetStats(
    agentIds: string[],
    since: string,
  ): Promise<Map<string, {
    sessions24h: number;
    errors24h: number;
    lastActivity?: string;
    skillsCount: number;
    mcpCount: number;
  }>> {
    const result = new Map<string, {
      sessions24h: number;
      errors24h: number;
      lastActivity?: string;
      skillsCount: number;
      mcpCount: number;
    }>();
    for (const id of agentIds) {
      result.set(id, { sessions24h: 0, errors24h: 0, skillsCount: 0, mcpCount: 0 });
    }
    if (agentIds.length === 0) return result;

    // Sessions active in the last 24h. Derived from the `sessions` table
    // (`last_activity_at > since`) rather than `count(distinct session_id)` over
    // the high-volume `session_events` table — the latter times out at fleet
    // scale (see issue #208). Backed by idx_sessions_agent (agent_id,
    // last_activity_at).
    const sessionRows = await this.db
      .select({
        agentId: sessions.agentId,
        count: sql<number>`count(*)::int`,
      })
      .from(sessions)
      .where(and(
        inArray(sessions.agentId, agentIds),
        gt(sessions.lastActivityAt, since),
      ))
      .groupBy(sessions.agentId);
    for (const r of sessionRows) {
      const entry = result.get(r.agentId);
      if (entry) entry.sessions24h = r.count;
    }

    // Errors in last 24h.
    const errorRows = await this.db
      .select({
        agentId: sessionEvents.agentId,
        count: sql<number>`count(*)::int`,
      })
      .from(sessionEvents)
      .where(and(
        inArray(sessionEvents.agentId, agentIds),
        eq(sessionEvents.eventType, 'error'),
        gt(sessionEvents.ts, since),
      ))
      .groupBy(sessionEvents.agentId);
    for (const r of errorRows) {
      const entry = result.get(r.agentId);
      if (entry) entry.errors24h = r.count;
    }

    // Last activity timestamp (max last_activity_at across the agent's
    // sessions). From the `sessions` table (idx_sessions_agent) instead of
    // max(ts) over all session_events, which scanned every event per agent.
    const lastRows = await this.db
      .select({
        agentId: sessions.agentId,
        lastTs: sql<string>`max(${sessions.lastActivityAt})`,
      })
      .from(sessions)
      .where(inArray(sessions.agentId, agentIds))
      .groupBy(sessions.agentId);
    for (const r of lastRows) {
      const entry = result.get(r.agentId);
      if (entry && r.lastTs) entry.lastActivity = r.lastTs;
    }

    // Skill counts: count skills enabled for the agent, including wildcard.
    const wildcardSkillCount = (await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(agentSkills)
      .where(and(eq(agentSkills.agentId, '*'), eq(agentSkills.enabled, true))))[0]?.count ?? 0;
    const perAgentSkillRows = await this.db
      .select({
        agentId: agentSkills.agentId,
        count: sql<number>`count(*)::int`,
      })
      .from(agentSkills)
      .where(and(
        inArray(agentSkills.agentId, agentIds),
        eq(agentSkills.enabled, true),
      ))
      .groupBy(agentSkills.agentId);
    for (const id of agentIds) {
      const own = perAgentSkillRows.find((r) => r.agentId === id)?.count ?? 0;
      const entry = result.get(id);
      if (entry) entry.skillsCount = own + wildcardSkillCount;
    }

    // MCP counts: same shape.
    const wildcardMcpCount = (await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(agentMcpServers)
      .where(and(eq(agentMcpServers.agentId, '*'), eq(agentMcpServers.enabled, true))))[0]?.count ?? 0;
    const perAgentMcpRows = await this.db
      .select({
        agentId: agentMcpServers.agentId,
        count: sql<number>`count(*)::int`,
      })
      .from(agentMcpServers)
      .where(and(
        inArray(agentMcpServers.agentId, agentIds),
        eq(agentMcpServers.enabled, true),
      ))
      .groupBy(agentMcpServers.agentId);
    for (const id of agentIds) {
      const own = perAgentMcpRows.find((r) => r.agentId === id)?.count ?? 0;
      const entry = result.get(id);
      if (entry) entry.mcpCount = own + wildcardMcpCount;
    }

    return result;
  }

  async getBackendState(agentId: string): Promise<Record<string, unknown> | null> {
    const [row] = await this.db.select({ backendState: agents.backendState }).from(agents).where(eq(agents.agentId, agentId));
    return (row?.backendState as Record<string, unknown>) ?? null;
  }

  async setBackendState(agentId: string, state: Record<string, unknown>): Promise<void> {
    await this.db.update(agents).set({
      backendState: state,
      updatedAt: new Date().toISOString(),
    }).where(eq(agents.agentId, agentId));
  }

  async counts(): Promise<{ users: number; sessions: number; sessionEvents: number }> {
    const [[u], [s], [e]] = await Promise.all([
      this.db.select({ count: sql<number>`count(*)::int` }).from(users),
      this.db.select({ count: sql<number>`count(*)::int` }).from(sessions),
      this.db.select({ count: sql<number>`count(*)::int` }).from(sessionEvents),
    ]);
    return { users: u!.count, sessions: s!.count, sessionEvents: e!.count };
  }

  /**
   * Per-agent token + cost aggregates for the fleet list: last 24h and last
   * 7 days. Sums the `usage` block stored on every `assistant` event payload
   * (input / output / cacheRead / cacheWrite tokens + pre-computed
   * `cost.total` USD). Returns a Map keyed by agentId; agents absent from
   * the result had no billable activity in either window.
   *
   * Deliberately NO all-time bucket and NO agent-id IN list in the SQL. This
   * runs on every fleet-view poll with the entire fleet as input, so the IN
   * list filtered nothing while adding ~1.8k bind params, and the all-time
   * bucket re-scanned the whole events history on every call (90s+ per call
   * once the table hit a few GB — the 2026-07-18 DB CPU incident). A single
   * 7-day scan with FILTER aggregates stays on the partial usage index.
   * All-time totals live where they're actually shown: the per-agent
   * drilldown (`agentUsageDetail`) and the stats panel (`usageTotals`).
   */
  async fleetUsage(agentIds: string[]): Promise<Map<string, FleetUsageWindows>> {
    const result = new Map<string, FleetUsageWindows>();
    if (agentIds.length === 0) return result;

    const now = new Date();
    const since24h = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const since7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const rows = await this.db.execute<{
      agent_id: string;
      input_24h: string | null;
      output_24h: string | null;
      cache_read_24h: string | null;
      cache_write_24h: string | null;
      usd_24h: number | null;
      input_7d: string | null;
      output_7d: string | null;
      cache_read_7d: string | null;
      cache_write_7d: string | null;
      usd_7d: number | null;
    }>(sql`
      SELECT
        agent_id,
        SUM(COALESCE((payload->'usage'->>'input')::bigint, 0))      FILTER (WHERE ts > ${since24h})::text AS input_24h,
        SUM(COALESCE((payload->'usage'->>'output')::bigint, 0))     FILTER (WHERE ts > ${since24h})::text AS output_24h,
        SUM(COALESCE((payload->'usage'->>'cacheRead')::bigint, 0))  FILTER (WHERE ts > ${since24h})::text AS cache_read_24h,
        SUM(COALESCE((payload->'usage'->>'cacheWrite')::bigint, 0)) FILTER (WHERE ts > ${since24h})::text AS cache_write_24h,
        SUM(GREATEST(COALESCE((payload->'usage'->'cost'->>'total')::numeric, 0), 0)) FILTER (WHERE ts > ${since24h})::float8 AS usd_24h,
        SUM(COALESCE((payload->'usage'->>'input')::bigint, 0))::text       AS input_7d,
        SUM(COALESCE((payload->'usage'->>'output')::bigint, 0))::text      AS output_7d,
        SUM(COALESCE((payload->'usage'->>'cacheRead')::bigint, 0))::text   AS cache_read_7d,
        SUM(COALESCE((payload->'usage'->>'cacheWrite')::bigint, 0))::text  AS cache_write_7d,
        SUM(GREATEST(COALESCE((payload->'usage'->'cost'->>'total')::numeric, 0), 0))::float8 AS usd_7d
      FROM ${sessionEvents}
      WHERE event_type = 'assistant'
        AND payload ? 'usage'
        AND ts > ${since7d}
      GROUP BY agent_id
    `);

    // The scan is fleet-wide; keep only the agents the caller asked about
    // (rows for deleted agents can still exist in session_events).
    const wanted = new Set(agentIds);
    for (const row of rows.rows) {
      if (!wanted.has(row.agent_id)) continue;
      result.set(row.agent_id, {
        window24h: {
          inputTokens: Number(row.input_24h ?? 0),
          outputTokens: Number(row.output_24h ?? 0),
          cacheReadTokens: Number(row.cache_read_24h ?? 0),
          cacheWriteTokens: Number(row.cache_write_24h ?? 0),
          costUsd: Number(row.usd_24h ?? 0),
        },
        window7d: {
          inputTokens: Number(row.input_7d ?? 0),
          outputTokens: Number(row.output_7d ?? 0),
          cacheReadTokens: Number(row.cache_read_7d ?? 0),
          cacheWriteTokens: Number(row.cache_write_7d ?? 0),
          costUsd: Number(row.usd_7d ?? 0),
        },
      });
    }
    return result;
  }

  /**
   * Gateway-wide token + cost totals for the system stats panel.
   * Two windows: last 24h and all-time.
   */
  async usageTotals(): Promise<{ window24h: UsageWindow; allTime: UsageWindow }> {
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const rows = await this.db.execute<{
      bucket: string;
      input_tokens: string | null;
      output_tokens: string | null;
      cache_read_tokens: string | null;
      cache_write_tokens: string | null;
      usd_total: number | null;
    }>(sql`
      WITH buckets AS (
        SELECT 'window24h' AS bucket, payload
          FROM ${sessionEvents}
          WHERE event_type = 'assistant' AND payload ? 'usage' AND ts > ${since24h}
        UNION ALL
        SELECT 'allTime' AS bucket, payload
          FROM ${sessionEvents}
          WHERE event_type = 'assistant' AND payload ? 'usage'
      )
      SELECT
        bucket,
        SUM(COALESCE((payload->'usage'->>'input')::bigint, 0))::text       AS input_tokens,
        SUM(COALESCE((payload->'usage'->>'output')::bigint, 0))::text      AS output_tokens,
        SUM(COALESCE((payload->'usage'->>'cacheRead')::bigint, 0))::text   AS cache_read_tokens,
        SUM(COALESCE((payload->'usage'->>'cacheWrite')::bigint, 0))::text  AS cache_write_tokens,
        SUM(GREATEST(COALESCE((payload->'usage'->'cost'->>'total')::numeric, 0), 0))::float8 AS usd_total
      FROM buckets
      GROUP BY bucket
    `);

    const empty: UsageWindow = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
    };
    const out = { window24h: { ...empty }, allTime: { ...empty } };
    for (const row of rows.rows) {
      const win: UsageWindow = {
        inputTokens: Number(row.input_tokens ?? 0),
        outputTokens: Number(row.output_tokens ?? 0),
        cacheReadTokens: Number(row.cache_read_tokens ?? 0),
        cacheWriteTokens: Number(row.cache_write_tokens ?? 0),
        costUsd: Number(row.usd_total ?? 0),
      };
      if (row.bucket === 'window24h') out.window24h = win;
      else out.allTime = win;
    }
    return out;
  }

  /**
   * Per-agent drilldown: token + cost totals plus a per-model breakdown
   * and a daily series for the last 30 days. Drives the "Usage" drawer in
   * the admin Fleet UI.
   */
  async agentUsageDetail(agentId: string): Promise<AgentUsageDetail> {
    const now = new Date();
    const since24h = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const since7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const since30d = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();

    // Single-agent totals across all three windows in one pass. Unlike
    // fleetUsage (7d only, fleet-wide), the all-time window is fine here:
    // the scan is bounded to one agent via the partial usage index.
    const totalsRows = await this.db.execute<{
      input_24h: string | null; output_24h: string | null;
      cache_read_24h: string | null; cache_write_24h: string | null; usd_24h: number | null;
      input_7d: string | null; output_7d: string | null;
      cache_read_7d: string | null; cache_write_7d: string | null; usd_7d: number | null;
      input_all: string | null; output_all: string | null;
      cache_read_all: string | null; cache_write_all: string | null; usd_all: number | null;
    }>(sql`
      SELECT
        SUM(COALESCE((payload->'usage'->>'input')::bigint, 0))      FILTER (WHERE ts > ${since24h})::text AS input_24h,
        SUM(COALESCE((payload->'usage'->>'output')::bigint, 0))     FILTER (WHERE ts > ${since24h})::text AS output_24h,
        SUM(COALESCE((payload->'usage'->>'cacheRead')::bigint, 0))  FILTER (WHERE ts > ${since24h})::text AS cache_read_24h,
        SUM(COALESCE((payload->'usage'->>'cacheWrite')::bigint, 0)) FILTER (WHERE ts > ${since24h})::text AS cache_write_24h,
        SUM(GREATEST(COALESCE((payload->'usage'->'cost'->>'total')::numeric, 0), 0)) FILTER (WHERE ts > ${since24h})::float8 AS usd_24h,
        SUM(COALESCE((payload->'usage'->>'input')::bigint, 0))      FILTER (WHERE ts > ${since7d})::text AS input_7d,
        SUM(COALESCE((payload->'usage'->>'output')::bigint, 0))     FILTER (WHERE ts > ${since7d})::text AS output_7d,
        SUM(COALESCE((payload->'usage'->>'cacheRead')::bigint, 0))  FILTER (WHERE ts > ${since7d})::text AS cache_read_7d,
        SUM(COALESCE((payload->'usage'->>'cacheWrite')::bigint, 0)) FILTER (WHERE ts > ${since7d})::text AS cache_write_7d,
        SUM(GREATEST(COALESCE((payload->'usage'->'cost'->>'total')::numeric, 0), 0)) FILTER (WHERE ts > ${since7d})::float8 AS usd_7d,
        SUM(COALESCE((payload->'usage'->>'input')::bigint, 0))::text       AS input_all,
        SUM(COALESCE((payload->'usage'->>'output')::bigint, 0))::text      AS output_all,
        SUM(COALESCE((payload->'usage'->>'cacheRead')::bigint, 0))::text   AS cache_read_all,
        SUM(COALESCE((payload->'usage'->>'cacheWrite')::bigint, 0))::text  AS cache_write_all,
        SUM(GREATEST(COALESCE((payload->'usage'->'cost'->>'total')::numeric, 0), 0))::float8 AS usd_all
      FROM ${sessionEvents}
      WHERE event_type = 'assistant'
        AND payload ? 'usage'
        AND agent_id = ${agentId}
    `);
    const t = totalsRows.rows[0];
    const totalsEntry: FleetUsageEntry = {
      window24h: {
        inputTokens: Number(t?.input_24h ?? 0),
        outputTokens: Number(t?.output_24h ?? 0),
        cacheReadTokens: Number(t?.cache_read_24h ?? 0),
        cacheWriteTokens: Number(t?.cache_write_24h ?? 0),
        costUsd: Number(t?.usd_24h ?? 0),
      },
      window7d: {
        inputTokens: Number(t?.input_7d ?? 0),
        outputTokens: Number(t?.output_7d ?? 0),
        cacheReadTokens: Number(t?.cache_read_7d ?? 0),
        cacheWriteTokens: Number(t?.cache_write_7d ?? 0),
        costUsd: Number(t?.usd_7d ?? 0),
      },
      allTime: {
        inputTokens: Number(t?.input_all ?? 0),
        outputTokens: Number(t?.output_all ?? 0),
        cacheReadTokens: Number(t?.cache_read_all ?? 0),
        cacheWriteTokens: Number(t?.cache_write_all ?? 0),
        costUsd: Number(t?.usd_all ?? 0),
      },
    };

    const modelRows = await this.db.execute<{
      model: string | null;
      provider: string | null;
      calls: string | null;
      input_tokens: string | null;
      output_tokens: string | null;
      usd_total: number | null;
    }>(sql`
      SELECT
        payload->>'model'    AS model,
        payload->>'provider' AS provider,
        COUNT(*)::text       AS calls,
        SUM(COALESCE((payload->'usage'->>'input')::bigint, 0))::text  AS input_tokens,
        SUM(COALESCE((payload->'usage'->>'output')::bigint, 0))::text AS output_tokens,
        SUM(GREATEST(COALESCE((payload->'usage'->'cost'->>'total')::numeric, 0), 0))::float8 AS usd_total
      FROM ${sessionEvents}
      WHERE event_type = 'assistant'
        AND payload ? 'usage'
        AND agent_id = ${agentId}
      GROUP BY model, provider
      ORDER BY usd_total DESC NULLS LAST
    `);

    const dailyRows = await this.db.execute<{
      day: string;
      input_tokens: string | null;
      output_tokens: string | null;
      usd_total: number | null;
    }>(sql`
      SELECT
        to_char(date_trunc('day', ts::timestamptz), 'YYYY-MM-DD') AS day,
        SUM(COALESCE((payload->'usage'->>'input')::bigint, 0))::text  AS input_tokens,
        SUM(COALESCE((payload->'usage'->>'output')::bigint, 0))::text AS output_tokens,
        SUM(GREATEST(COALESCE((payload->'usage'->'cost'->>'total')::numeric, 0), 0))::float8 AS usd_total
      FROM ${sessionEvents}
      WHERE event_type = 'assistant'
        AND payload ? 'usage'
        AND agent_id = ${agentId}
        AND ts > ${since30d}
      GROUP BY day
      ORDER BY day ASC
    `);

    return {
      totals: totalsEntry,
      byModel: modelRows.rows.map((r) => ({
        model: r.model ?? '(unknown)',
        ...(r.provider ? { provider: r.provider } : {}),
        calls: Number(r.calls ?? 0),
        inputTokens: Number(r.input_tokens ?? 0),
        outputTokens: Number(r.output_tokens ?? 0),
        costUsd: Number(r.usd_total ?? 0),
      })),
      daily: dailyRows.rows.map((r) => ({
        day: r.day,
        inputTokens: Number(r.input_tokens ?? 0),
        outputTokens: Number(r.output_tokens ?? 0),
        costUsd: Number(r.usd_total ?? 0),
      })),
    };
  }

  /**
   * Hard-delete an agent and every agent-scoped row across the schema.
   * Most child tables don't have a real FK back to agents (they reference
   * agent_id by string), so we have to enumerate them here. Order doesn't
   * really matter — none of these reference each other through agents.
   *
   * On-disk artifacts (workspace dir, skill-mounts at <home>/agents/<id>)
   * are left for the operator to clean up; deletion may be destructive
   * and is rarely worth automating.
   */
  async delete(agentId: string): Promise<void> {
    const where = eq(sessionEvents.agentId, agentId);
    await this.db.delete(sessionEvents).where(where);
    await this.db.delete(sessions).where(eq(sessions.agentId, agentId));
    await this.db.delete(scheduleRuns).where(eq(scheduleRuns.agentId, agentId));
    await this.db.delete(schedules).where(eq(schedules.agentId, agentId));
    await this.db.delete(agentChannels).where(eq(agentChannels.agentId, agentId));
    await this.db.delete(agentSecrets).where(eq(agentSecrets.agentId, agentId));
    await this.db.delete(agentSkills).where(eq(agentSkills.agentId, agentId));
    await this.db.delete(agentMcpServers).where(eq(agentMcpServers.agentId, agentId));
    await this.db.delete(memories).where(eq(memories.agentId, agentId));
    await this.db.delete(sandboxes).where(eq(sandboxes.agentId, agentId));
    await this.db.delete(instructions).where(eq(instructions.agentId, agentId));
    // user_agents has ON DELETE CASCADE — it goes away with the agents row.
    await this.db.delete(agents).where(eq(agents.agentId, agentId));
  }

  private toRecord(row: typeof agents.$inferSelect): AgentRecord {
    return {
      agentId: row.agentId,
      ...(row.name ? { name: row.name } : {}),
      workspaceDir: row.workspaceDir,
      status: row.status as AgentStatus,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
