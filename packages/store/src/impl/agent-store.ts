import { drizzle } from 'drizzle-orm/node-postgres';
import { and, eq, gt, inArray, sql } from 'drizzle-orm';
import pg from 'pg';

import type { AgentStore } from '../interfaces.js';
import type { AgentRecord, AgentStatus } from '../types.js';
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
