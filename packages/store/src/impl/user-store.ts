import { drizzle } from 'drizzle-orm/node-postgres';
import { eq, and, asc, isNull, sql, inArray } from 'drizzle-orm';
import pg from 'pg';

import type { UserStore } from '../interfaces.js';
import type { StoreScope, UserAgentRecord, UserIdentity, UserRecord, UserRole } from '../types.js';
import * as schema from '../schema.js';
import { users, userAgents, userIdentities, sessionEvents, schedules } from '../schema.js';
import type { DrizzleDb } from './index.js';

export class DbUserStore implements UserStore {
  private pool?: pg.Pool;

  constructor(private readonly db: DrizzleDb) {}

  static async open(databaseUrl?: string): Promise<DbUserStore> {
    const url = databaseUrl ?? process.env.DATABASE_URL;
    if (!url) {
      throw new Error('DATABASE_URL environment variable is required');
    }
    const pool = new pg.Pool({ connectionString: url });
    await pool.query('SELECT 1');
    const db = drizzle(pool, { schema });
    const store = new DbUserStore(db);
    store.pool = pool;
    return store;
  }

  async close(): Promise<void> {
    await this.pool?.end();
  }

  async upsert(user: UserRecord): Promise<void> {
    await this.db.insert(users).values({
      userId: user.userId,
      name: user.name ?? null,
      mergedInto: user.mergedInto ?? null,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    }).onConflictDoUpdate({
      target: users.userId,
      set: {
        name: user.name ?? null,
        mergedInto: user.mergedInto ?? null,
        updatedAt: user.updatedAt,
      },
    });
  }

  async get(userId: string): Promise<UserRecord | undefined> {
    const [row] = await this.db.select().from(users)
      .where(and(eq(users.userId, userId), isNull(users.mergedInto)));
    if (!row) return undefined;
    return this.rowToUserRecord(row);
  }

  async list(): Promise<UserRecord[]> {
    const rows = await this.db.select().from(users)
      .where(isNull(users.mergedInto))
      .orderBy(asc(users.createdAt));
    return rows.map((row) => this.rowToUserRecord(row));
  }

  async linkIdentity(identity: UserIdentity): Promise<void> {
    const [previous] = await this.db.select().from(userIdentities)
      .where(and(
        eq(userIdentities.channel, identity.channel),
        eq(userIdentities.channelUserId, identity.channelUserId),
      ));
    const previousUserId = previous?.userId;

    await this.db.insert(userIdentities).values({
      userId: identity.userId,
      channel: identity.channel,
      channelUserId: identity.channelUserId,
      createdAt: identity.createdAt,
    }).onConflictDoUpdate({
      target: [userIdentities.channel, userIdentities.channelUserId],
      set: { userId: identity.userId },
    });

    if (previousUserId && previousUserId !== identity.userId) {
      await this.cleanupOrphanedUser(previousUserId, identity.userId);
    }
  }

  async resolve(channel: string, channelUserId: string): Promise<string | undefined> {
    const [identity] = await this.db.select({
      userId: userIdentities.userId,
      mergedInto: users.mergedInto,
    }).from(userIdentities)
      .innerJoin(users, eq(userIdentities.userId, users.userId))
      .where(and(
        eq(userIdentities.channel, channel),
        eq(userIdentities.channelUserId, channelUserId),
      ));

    if (!identity) return undefined;
    return typeof identity.mergedInto === 'string' ? identity.mergedInto : identity.userId;
  }

  async unlinkIdentity(channel: string, channelUserId: string): Promise<void> {
    await this.db.delete(userIdentities)
      .where(and(eq(userIdentities.channel, channel), eq(userIdentities.channelUserId, channelUserId)));
  }

  async listIdentities(userId: string): Promise<UserIdentity[]> {
    const rows = await this.db.select().from(userIdentities)
      .where(eq(userIdentities.userId, userId))
      .orderBy(asc(userIdentities.createdAt));
    return rows.map((row) => ({
      userId: row.userId,
      channel: row.channel,
      channelUserId: row.channelUserId,
      createdAt: row.createdAt,
    }));
  }

  async listIdentitiesByUserIds(userIdList: string[]): Promise<Map<string, UserIdentity[]>> {
    const grouped = new Map<string, UserIdentity[]>();
    if (userIdList.length === 0) return grouped;
    const rows = await this.db.select().from(userIdentities)
      .where(inArray(userIdentities.userId, userIdList))
      .orderBy(asc(userIdentities.createdAt));
    for (const row of rows) {
      const entry: UserIdentity = {
        userId: row.userId,
        channel: row.channel,
        channelUserId: row.channelUserId,
        createdAt: row.createdAt,
      };
      const existing = grouped.get(row.userId);
      if (existing) existing.push(entry);
      else grouped.set(row.userId, [entry]);
    }
    return grouped;
  }

  async merge(fromUserId: string, intoUserId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.update(userIdentities).set({ userId: intoUserId })
        .where(eq(userIdentities.userId, fromUserId));

      const fromAgents = await tx.select().from(userAgents)
        .where(eq(userAgents.userId, fromUserId));
      for (const ua of fromAgents) {
        const [exists] = await tx.select().from(userAgents)
          .where(and(eq(userAgents.userId, intoUserId), eq(userAgents.agentId, ua.agentId)));
        if (!exists) {
          await tx.insert(userAgents).values({
            userId: intoUserId,
            agentId: ua.agentId,
            role: ua.role,
            createdAt: ua.createdAt,
          });
        }
      }
      await tx.delete(userAgents).where(eq(userAgents.userId, fromUserId));

      await tx.update(sessionEvents).set({ userId: intoUserId })
        .where(eq(sessionEvents.userId, fromUserId));

      await tx.delete(users).where(eq(users.userId, fromUserId));
    });
  }

  async delete(userId: string): Promise<void> {
    await this.db.delete(users).where(eq(users.userId, userId));
  }

  async assignAgent(scope: StoreScope, userId: string, role: UserRole, createdAt: string): Promise<void> {
    await this.db.insert(userAgents)
      .values({ userId, agentId: scope.agentId, role, createdAt })
      .onConflictDoUpdate({
        target: [userAgents.userId, userAgents.agentId],
        set: { role },
      });
  }

  async removeAgent(scope: StoreScope, userId: string): Promise<void> {
    await this.db.delete(userAgents)
      .where(and(eq(userAgents.userId, userId), eq(userAgents.agentId, scope.agentId)));
  }

  async getAgentRole(scope: StoreScope, userId: string): Promise<UserRole | undefined> {
    const [row] = await this.db.select().from(userAgents)
      .where(and(eq(userAgents.userId, userId), eq(userAgents.agentId, scope.agentId)));
    return row ? (row.role as UserRole) : undefined;
  }

  async listByAgent(scope: StoreScope): Promise<UserAgentRecord[]> {
    const rows = await this.db.select().from(userAgents)
      .where(eq(userAgents.agentId, scope.agentId))
      .orderBy(asc(userAgents.createdAt));
    return rows.map((row) => ({
      userId: row.userId,
      agentId: row.agentId,
      role: row.role as UserRole,
      createdAt: row.createdAt,
    }));
  }

  /** All (agentId, role) bindings for a single user. */
  async listAgentRoles(userId: string): Promise<UserAgentRecord[]> {
    const rows = await this.db.select().from(userAgents)
      .where(eq(userAgents.userId, userId))
      .orderBy(asc(userAgents.createdAt));
    return rows.map((row) => ({
      userId: row.userId,
      agentId: row.agentId,
      role: row.role as UserRole,
      createdAt: row.createdAt,
    }));
  }

  async listAgentRolesByUserIds(userIdList: string[]): Promise<Map<string, UserAgentRecord[]>> {
    const grouped = new Map<string, UserAgentRecord[]>();
    if (userIdList.length === 0) return grouped;
    const rows = await this.db.select().from(userAgents)
      .where(inArray(userAgents.userId, userIdList))
      .orderBy(asc(userAgents.createdAt));
    for (const row of rows) {
      const entry: UserAgentRecord = {
        userId: row.userId,
        agentId: row.agentId,
        role: row.role as UserRole,
        createdAt: row.createdAt,
      };
      const existing = grouped.get(row.userId);
      if (existing) existing.push(entry);
      else grouped.set(row.userId, [entry]);
    }
    return grouped;
  }

  private async cleanupOrphanedUser(orphanUserId: string, newUserId: string): Promise<void> {
    const [row] = await this.db.select({ count: sql<number>`count(*)::int` }).from(userIdentities)
      .where(eq(userIdentities.userId, orphanUserId));
    if ((row?.count ?? 0) > 0) return;

    // The orphan is about to be deleted, so every reference to it must be
    // re-pointed at the surviving user first. Leaving one dangling is not
    // cosmetic: schedules.created_by is resolved on every scheduled firing
    // to decide the turn's role — a deleted creator falls through to guest,
    // silently stripping owner-gated tools (exec/CLI) from all of the
    // agent's cron work (2026-07-31 罗洪 incident; hert's 07-17 schedule
    // failure was the same class).
    await this.db.update(sessionEvents).set({ userId: newUserId })
      .where(eq(sessionEvents.userId, orphanUserId));
    await this.db.update(schedules).set({ createdBy: newUserId })
      .where(eq(schedules.createdBy, orphanUserId));

    // Agent roles: move each of the orphan's memberships to the survivor.
    // Where both users have a role on the same agent, keep the stronger one
    // (owner > user > guest) on the survivor and drop the orphan's row —
    // a merge must never demote the surviving identity.
    const rank: Record<string, number> = { owner: 3, user: 2, guest: 1 };
    const orphanRoles = await this.db.select().from(userAgents)
      .where(eq(userAgents.userId, orphanUserId));
    for (const membership of orphanRoles) {
      const [existing] = await this.db.select().from(userAgents).where(and(
        eq(userAgents.userId, newUserId),
        eq(userAgents.agentId, membership.agentId),
      ));
      if (!existing) {
        await this.db.update(userAgents)
          .set({ userId: newUserId })
          .where(and(
            eq(userAgents.userId, orphanUserId),
            eq(userAgents.agentId, membership.agentId),
          ));
        continue;
      }
      if ((rank[membership.role] ?? 0) > (rank[existing.role] ?? 0)) {
        await this.db.update(userAgents)
          .set({ role: membership.role })
          .where(and(
            eq(userAgents.userId, newUserId),
            eq(userAgents.agentId, membership.agentId),
          ));
      }
      await this.db.delete(userAgents).where(and(
        eq(userAgents.userId, orphanUserId),
        eq(userAgents.agentId, membership.agentId),
      ));
    }

    await this.db.delete(users).where(eq(users.userId, orphanUserId));
  }

  private rowToUserRecord(row: typeof users.$inferSelect): UserRecord {
    const record: UserRecord = {
      userId: row.userId,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
    if (row.name !== null) record.name = row.name;
    if (row.mergedInto !== null) record.mergedInto = row.mergedInto;
    return record;
  }
}
