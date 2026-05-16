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

    // Sessions touched in the last 24h (distinct session_id with any event).
    const sessionRows = await this.db
      .select({
        agentId: sessionEvents.agentId,
        count: sql<number>`count(distinct ${sessionEvents.sessionId})::int`,
      })
      .from(sessionEvents)
      .where(and(
        inArray(sessionEvents.agentId, agentIds),
        gt(sessionEvents.ts, since),
      ))
      .groupBy(sessionEvents.agentId);
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

    // Last activity timestamp (max ts across all events).
    const lastRows = await this.db
      .select({
        agentId: sessionEvents.agentId,
        lastTs: sql<string>`max(${sessionEvents.ts})`,
      })
      .from(sessionEvents)
      .where(inArray(sessionEvents.agentId, agentIds))
      .groupBy(sessionEvents.agentId);
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
   * Per-agent token + cost aggregates across three windows: 24h, 7d, all-time.
   * Sums the `usage` block stored on every `assistant` event payload
   * (input / output / cacheRead / cacheWrite tokens + pre-computed
   * `cost.total` USD). Returns a Map keyed by agentId; agents absent from
   * the result had no billable activity in any window.
   */
  async fleetUsage(agentIds: string[]): Promise<Map<string, FleetUsageEntry>> {
    const result = new Map<string, FleetUsageEntry>();
    if (agentIds.length === 0) return result;

    const now = new Date();
    const since24h = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const since7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const rows = await this.db.execute<{
      agent_id: string;
      window: string;
      input_tokens: string | null;
      output_tokens: string | null;
      cache_read_tokens: string | null;
      cache_write_tokens: string | null;
      usd_total: number | null;
    }>(sql`
      WITH usage AS (
        SELECT agent_id, ts, payload
        FROM ${sessionEvents}
        WHERE event_type = 'assistant'
          AND payload ? 'usage'
          AND agent_id = ANY(${agentIds}::text[])
      ),
      buckets AS (
        SELECT agent_id, 'window24h' AS window, payload FROM usage WHERE ts > ${since24h}
        UNION ALL
        SELECT agent_id, 'window7d'  AS window, payload FROM usage WHERE ts > ${since7d}
        UNION ALL
        SELECT agent_id, 'allTime'   AS window, payload FROM usage
      )
      SELECT
        agent_id,
        window,
        SUM(COALESCE((payload->'usage'->>'input')::bigint, 0))::text       AS input_tokens,
        SUM(COALESCE((payload->'usage'->>'output')::bigint, 0))::text      AS output_tokens,
        SUM(COALESCE((payload->'usage'->>'cacheRead')::bigint, 0))::text   AS cache_read_tokens,
        SUM(COALESCE((payload->'usage'->>'cacheWrite')::bigint, 0))::text  AS cache_write_tokens,
        SUM(COALESCE((payload->'usage'->'cost'->>'total')::numeric, 0))::float8 AS usd_total
      FROM buckets
      GROUP BY agent_id, window
    `);

    const empty = (): UsageWindow => ({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
    });
    const ensure = (id: string): FleetUsageEntry => {
      let entry = result.get(id);
      if (!entry) {
        entry = { window24h: empty(), window7d: empty(), allTime: empty() };
        result.set(id, entry);
      }
      return entry;
    };
    for (const row of rows.rows) {
      const entry = ensure(row.agent_id);
      const bucket: UsageWindow = {
        inputTokens: Number(row.input_tokens ?? 0),
        outputTokens: Number(row.output_tokens ?? 0),
        cacheReadTokens: Number(row.cache_read_tokens ?? 0),
        cacheWriteTokens: Number(row.cache_write_tokens ?? 0),
        costUsd: Number(row.usd_total ?? 0),
      };
      if (row.window === 'window24h') entry.window24h = bucket;
      else if (row.window === 'window7d') entry.window7d = bucket;
      else entry.allTime = bucket;
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
      window: string;
      input_tokens: string | null;
      output_tokens: string | null;
      cache_read_tokens: string | null;
      cache_write_tokens: string | null;
      usd_total: number | null;
    }>(sql`
      WITH buckets AS (
        SELECT 'window24h' AS window, payload
          FROM ${sessionEvents}
          WHERE event_type = 'assistant' AND payload ? 'usage' AND ts > ${since24h}
        UNION ALL
        SELECT 'allTime' AS window, payload
          FROM ${sessionEvents}
          WHERE event_type = 'assistant' AND payload ? 'usage'
      )
      SELECT
        window,
        SUM(COALESCE((payload->'usage'->>'input')::bigint, 0))::text       AS input_tokens,
        SUM(COALESCE((payload->'usage'->>'output')::bigint, 0))::text      AS output_tokens,
        SUM(COALESCE((payload->'usage'->>'cacheRead')::bigint, 0))::text   AS cache_read_tokens,
        SUM(COALESCE((payload->'usage'->>'cacheWrite')::bigint, 0))::text  AS cache_write_tokens,
        SUM(COALESCE((payload->'usage'->'cost'->>'total')::numeric, 0))::float8 AS usd_total
      FROM buckets
      GROUP BY window
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
      const bucket: UsageWindow = {
        inputTokens: Number(row.input_tokens ?? 0),
        outputTokens: Number(row.output_tokens ?? 0),
        cacheReadTokens: Number(row.cache_read_tokens ?? 0),
        cacheWriteTokens: Number(row.cache_write_tokens ?? 0),
        costUsd: Number(row.usd_total ?? 0),
      };
      if (row.window === 'window24h') out.window24h = bucket;
      else out.allTime = bucket;
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

    const [totals] = await Promise.all([this.fleetUsage([agentId])]);
    const totalsEntry = totals.get(agentId) ?? {
      window24h: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 },
      window7d:  { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 },
      allTime:   { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 },
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
        SUM(COALESCE((payload->'usage'->'cost'->>'total')::numeric, 0))::float8 AS usd_total
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
        SUM(COALESCE((payload->'usage'->'cost'->>'total')::numeric, 0))::float8 AS usd_total
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
