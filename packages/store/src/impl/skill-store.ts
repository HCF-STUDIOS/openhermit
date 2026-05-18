import { drizzle } from 'drizzle-orm/node-postgres';
import { eq, inArray, asc } from 'drizzle-orm';
import pg from 'pg';

import type { SkillStore } from '../interfaces.js';
import type { AgentSkillRecord, SkillRecord } from '../types.js';
import * as schema from '../schema.js';
import { skills, agentSkills } from '../schema.js';
import type { DrizzleDb } from './index.js';

export class DbSkillStore implements SkillStore {
  private pool?: pg.Pool;

  constructor(private readonly db: DrizzleDb) {}

  static async open(databaseUrl?: string): Promise<DbSkillStore> {
    const url = databaseUrl ?? process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL environment variable is required');
    const pool = new pg.Pool({ connectionString: url });
    await pool.query('SELECT 1');
    const db = drizzle(pool, { schema });
    const store = new DbSkillStore(db);
    store.pool = pool;
    return store;
  }

  async close(): Promise<void> {
    await this.pool?.end();
  }

  async upsert(skill: SkillRecord): Promise<void> {
    const data = {
      name: skill.name,
      description: skill.description,
      path: skill.path,
      source: skill.source,
      ownerAgentId: skill.ownerAgentId ?? null,
      metadata: (skill.metadata ?? {}) as Record<string, unknown>,
      createdAt: skill.createdAt,
      updatedAt: skill.updatedAt,
    };
    await this.db.insert(skills).values({ id: skill.id, ...data })
      .onConflictDoUpdate({ target: skills.id, set: data });
  }

  async get(id: string): Promise<SkillRecord | undefined> {
    const [row] = await this.db.select().from(skills).where(eq(skills.id, id));
    if (!row) return undefined;
    return this.rowToRecord(row);
  }

  async list(): Promise<SkillRecord[]> {
    const rows = await this.db.select().from(skills).orderBy(asc(skills.name));
    return rows.map((r) => this.rowToRecord(r));
  }

  async delete(id: string): Promise<void> {
    await this.db.delete(skills).where(eq(skills.id, id)).catch(() => undefined);
  }

  async enable(agentId: string, skillId: string): Promise<void> {
    const now = new Date().toISOString();
    await this.db.insert(agentSkills)
      .values({ agentId, skillId, enabled: true, createdAt: now })
      .onConflictDoUpdate({
        target: [agentSkills.agentId, agentSkills.skillId],
        set: { enabled: true },
      });
  }

  async disable(agentId: string, skillId: string): Promise<void> {
    const now = new Date().toISOString();
    await this.db.insert(agentSkills)
      .values({ agentId, skillId, enabled: false, createdAt: now })
      .onConflictDoUpdate({
        target: [agentSkills.agentId, agentSkills.skillId],
        set: { enabled: false },
      });
  }

  async listEnabled(agentId: string): Promise<SkillRecord[]> {
    // Pull both the wildcard row and the per-agent row regardless of enabled
    // state. A per-agent row always overrides the wildcard so that
    // `disable --agent X` after `enable --all` actually opts X out.
    const rows = await this.db.select({
      skillId: agentSkills.skillId,
      assignmentAgentId: agentSkills.agentId,
      enabled: agentSkills.enabled,
      id: skills.id,
      name: skills.name,
      description: skills.description,
      path: skills.path,
      source: skills.source,
      ownerAgentId: skills.ownerAgentId,
      metadata: skills.metadata,
      createdAt: skills.createdAt,
      updatedAt: skills.updatedAt,
    }).from(agentSkills)
      .innerJoin(skills, eq(agentSkills.skillId, skills.id))
      .where(inArray(agentSkills.agentId, [agentId, '*']));

    const effective = new Map<string, typeof rows[number]>();
    for (const row of rows) {
      const prior = effective.get(row.skillId);
      if (!prior || (prior.assignmentAgentId === '*' && row.assignmentAgentId === agentId)) {
        effective.set(row.skillId, row);
      }
    }

    const result: SkillRecord[] = [];
    for (const row of effective.values()) {
      if (row.enabled) result.push(this.rowToRecord(row));
    }
    return result.sort((a, b) => a.name.localeCompare(b.name));
  }

  async listAssignments(skillId?: string): Promise<AgentSkillRecord[]> {
    const q = skillId
      ? this.db.select().from(agentSkills).where(eq(agentSkills.skillId, skillId))
      : this.db.select().from(agentSkills);
    const rows = await q;
    return rows.map((r) => ({
      agentId: r.agentId,
      skillId: r.skillId,
      enabled: r.enabled,
      createdAt: r.createdAt,
    }));
  }

  private rowToRecord(row: {
    id: string;
    name: string;
    description: string;
    path: string;
    source: string;
    ownerAgentId: string | null;
    metadata: unknown;
    createdAt: string;
    updatedAt: string;
  }): SkillRecord {
    const metadata = (row.metadata ?? {}) as Record<string, unknown>;
    const source = row.source === 'user' ? 'user' : 'system';
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      path: row.path,
      source,
      ...(row.ownerAgentId ? { ownerAgentId: row.ownerAgentId } : {}),
      ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
