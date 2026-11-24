import { drizzle } from 'drizzle-orm/node-postgres';
import { eq, and, asc, isNull, sql, inArray } from 'drizzle-orm';
import pg from 'pg';
import { createStorePool } from './pool.js';
import { rethrowOwnerConflict } from './owner-conflict.js';

import type { UserStore } from '../interfaces.js';
import type { StoreScope, UserAgentRecord, UserIdentity, UserRecord, UserRole } from '../types.js';
import * as schema from '../schema.js';
import { users, userAgents, userIdentities, sessionEvents, schedules } from '../schema.js';
import type { DrizzleDb } from './index.js';

type Tx = Parameters<Parameters<DrizzleDb['transaction']>[0]>[0];

/** Role strength for merges: a merge must never demote the surviving user. */
const ROLE_RANK: Record<string, number> = { owner: 3, user: 2, guest: 1 };

export class DbUserStore implements UserStore {
  private pool?: pg.Pool;

  constructor(private readonly db: DrizzleDb) {}

  static async open(databaseUrl?: string): Promise<DbUserStore> {
    const url = databaseUrl ?? process.env.DATABASE_URL;
    if (!url) {
      throw new Error('DATABASE_URL environment variable is required');
    }
    const pool = createStorePool(url);
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
    // Select-previous + upsert + orphan cleanup in ONE transaction: a crash or
    // concurrent link between the steps must not strand the previous owner of
    // this identity half-migrated (deleted user, dangling references).
    await this.db.transaction(async (tx) => {
      const [previous] = await tx.select().from(userIdentities)
        .where(and(
          eq(userIdentities.channel, identity.channel),
          eq(userIdentities.channelUserId, identity.channelUserId),
        ));
      const previousUserId = previous?.userId;

      await tx.insert(userIdentities).values({
        userId: identity.userId,
        channel: identity.channel,
        channelUserId: identity.channelUserId,
        createdAt: identity.createdAt,
      }).onConflictDoUpdate({
        target: [userIdentities.channel, userIdentities.channelUserId],
        set: { userId: identity.userId },
      });

      if (previousUserId && previousUserId !== identity.userId) {
        await this.cleanupOrphanedUser(tx, previousUserId, identity.userId);
      }
    });
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
      await this.reassignUser(tx, fromUserId, intoUserId);
      await tx.delete(users).where(eq(users.userId, fromUserId));
    });
  }

  async delete(userId: string): Promise<void> {
    await this.db.delete(users).where(eq(users.userId, userId));
  }

  async assignAgent(scope: StoreScope, userId: string, role: UserRole, createdAt: string): Promise<void> {
    try {
      await this.db.insert(userAgents)
        .values({ userId, agentId: scope.agentId, role, createdAt })
        .onConflictDoUpdate({
          target: [userAgents.userId, userAgents.agentId],
          set: { role },
        });
    } catch (err) {
      // role='owner' on an already-owned agent trips the partial unique index
      // user_agents_one_owner — surface a clean 409 instead of a raw 500.
      // (Non-owner roles and same-user re-assignment never hit it.)
      throw rethrowOwnerConflict(err, scope.agentId);
    }
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

  private async cleanupOrphanedUser(tx: Tx, orphanUserId: string, newUserId: string): Promise<void> {
    // Serialize the orphan decision per orphan user. Under READ COMMITTED two
    // concurrent links moving the orphan's last two identities would each
    // still see the other's (uncommitted) identity, both skip cleanup, and
    // strand the orphan's memberships (possibly the agent's owner row). With
    // the row lock the second link waits, then counts with a fresh snapshot.
    await tx.select({ userId: users.userId }).from(users)
      .where(eq(users.userId, orphanUserId))
      .for('update');
    const [row] = await tx.select({ count: sql<number>`count(*)::int` }).from(userIdentities)
      .where(eq(userIdentities.userId, orphanUserId));
    if ((row?.count ?? 0) > 0) return;

    await this.reassignUser(tx, orphanUserId, newUserId);
    await tx.delete(users).where(eq(users.userId, orphanUserId));
  }

  /**
   * Re-point every reference to `fromUserId` at `intoUserId` ahead of deleting
   * `fromUserId`. Shared by merge() and the linkIdentity orphan cleanup so the
   * two can't drift.
   *
   * Leaving a reference dangling is not cosmetic: schedules.created_by is
   * resolved on every scheduled firing to decide the turn's role — a deleted
   * creator falls through to guest, silently stripping owner-gated tools
   * (exec/CLI) from all of the agent's cron work (2026-07-31 罗洪 incident;
   * hert's 07-17 schedule failure was the same class).
   */
  private async reassignUser(tx: Tx, fromUserId: string, intoUserId: string): Promise<void> {
    await tx.update(sessionEvents).set({ userId: intoUserId })
      .where(eq(sessionEvents.userId, fromUserId));
    await tx.update(schedules).set({ createdBy: intoUserId })
      .where(eq(schedules.createdBy, fromUserId));

    // Agent roles: move each of the source's memberships to the target. Where
    // both have a role on the same agent, keep the stronger one (owner > user
    // > guest) — a merge must never demote the surviving user, and dropping a
    // source owner row in favour of the target's guest row would leave the
    // agent ownerless.
    //
    // Each source row is deleted BEFORE the target row is inserted/upgraded:
    // otherwise two owner rows would coexist mid-transaction and trip the
    // one-owner partial unique index (migration 0036).
    const sourceRoles = await tx.select().from(userAgents)
      .where(eq(userAgents.userId, fromUserId));
    for (const membership of sourceRoles) {
      await tx.delete(userAgents).where(and(
        eq(userAgents.userId, fromUserId),
        eq(userAgents.agentId, membership.agentId),
      ));
      // Lock the target row so a concurrent assignAgent can't change its role
      // between this read and the rank comparison/upgrade below.
      const [existing] = await tx.select().from(userAgents).where(and(
        eq(userAgents.userId, intoUserId),
        eq(userAgents.agentId, membership.agentId),
      )).for('update');
      if (!existing) {
        await tx.insert(userAgents).values({
          userId: intoUserId,
          agentId: membership.agentId,
          role: membership.role,
          createdAt: membership.createdAt,
        });
      } else if ((ROLE_RANK[membership.role] ?? 0) > (ROLE_RANK[existing.role] ?? 0)) {
        await tx.update(userAgents)
          .set({ role: membership.role })
          .where(and(
            eq(userAgents.userId, intoUserId),
            eq(userAgents.agentId, membership.agentId),
          ));
      }
    }
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
