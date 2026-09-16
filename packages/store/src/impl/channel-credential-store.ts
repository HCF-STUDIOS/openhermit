import { drizzle } from 'drizzle-orm/node-postgres';
import { and, asc, eq } from 'drizzle-orm';
import type { ChannelCredentialStore } from '@openhermit/protocol';
import pg from 'pg';
import { createStorePool } from './pool.js';

import * as schema from '../schema.js';
import { agentChannelCredentials } from '../schema.js';
import {
  decryptString as decrypt,
  encryptString as encrypt,
  secretsKeyFromEnv,
} from './secret-crypto.js';
import type { DrizzleDb } from './index.js';

export class DbChannelCredentialStore {
  private pool?: pg.Pool;

  private constructor(
    private readonly db: DrizzleDb,
    private readonly key: Buffer,
  ) {}

  static async open(databaseUrl?: string): Promise<DbChannelCredentialStore> {
    const url = databaseUrl ?? process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL environment variable is required');
    const pool = createStorePool(url);
    try {
      await pool.query('SELECT 1');
      const db = drizzle(pool, { schema });
      const store = new DbChannelCredentialStore(db, secretsKeyFromEnv());
      store.pool = pool;
      return store;
    } catch (error) {
      await pool.end().catch(() => undefined);
      throw error;
    }
  }

  static withDb(db: DrizzleDb): DbChannelCredentialStore {
    return new DbChannelCredentialStore(db, secretsKeyFromEnv());
  }

  async close(): Promise<void> {
    await this.pool?.end();
  }

  scoped(agentId: string, channelType: string): ChannelCredentialStore {
    return {
      get: (profile: string, key: string) =>
        this.get(agentId, channelType, profile, key),
      list: (profile: string) =>
        this.list(agentId, channelType, profile),
      set: (profile: string, key: string, value: string) =>
        this.set(agentId, channelType, profile, key, value),
      delete: (profile: string, key: string) =>
        this.delete(agentId, channelType, profile, key),
      replace: (profile: string, values: Record<string, string>) =>
        this.replace(agentId, channelType, profile, values),
      clear: (profile: string) =>
        this.clear(agentId, channelType, profile),
    };
  }

  async get(
    agentId: string,
    channelType: string,
    profile: string,
    key: string,
  ): Promise<string | undefined> {
    const [row] = await this.db.select().from(agentChannelCredentials)
      .where(and(
        eq(agentChannelCredentials.agentId, agentId),
        eq(agentChannelCredentials.channelType, channelType),
        eq(agentChannelCredentials.profile, profile),
        eq(agentChannelCredentials.key, key),
      ));
    if (!row) return undefined;
    try {
      return decrypt(this.key, row.valueCiphertext);
    } catch {
      return undefined;
    }
  }

  async list(
    agentId: string,
    channelType: string,
    profile: string,
  ): Promise<Record<string, string>> {
    const rows = await this.db.select().from(agentChannelCredentials)
      .where(and(
        eq(agentChannelCredentials.agentId, agentId),
        eq(agentChannelCredentials.channelType, channelType),
        eq(agentChannelCredentials.profile, profile),
      ))
      .orderBy(asc(agentChannelCredentials.key));
    const out: Record<string, string> = {};
    for (const row of rows) {
      try {
        out[row.key] = decrypt(this.key, row.valueCiphertext);
      } catch {
        // Skip entries encrypted with a different key so callers can relink.
      }
    }
    return out;
  }

  async set(
    agentId: string,
    channelType: string,
    profile: string,
    key: string,
    value: string,
  ): Promise<void> {
    const now = new Date().toISOString();
    const valueCiphertext = encrypt(this.key, value);
    await this.db.insert(agentChannelCredentials)
      .values({
        agentId,
        channelType,
        profile,
        key,
        valueCiphertext,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          agentChannelCredentials.agentId,
          agentChannelCredentials.channelType,
          agentChannelCredentials.profile,
          agentChannelCredentials.key,
        ],
        set: { valueCiphertext, updatedAt: now },
      });
  }

  async delete(
    agentId: string,
    channelType: string,
    profile: string,
    key: string,
  ): Promise<void> {
    await this.db.delete(agentChannelCredentials)
      .where(and(
        eq(agentChannelCredentials.agentId, agentId),
        eq(agentChannelCredentials.channelType, channelType),
        eq(agentChannelCredentials.profile, profile),
        eq(agentChannelCredentials.key, key),
      ));
  }

  async replace(
    agentId: string,
    channelType: string,
    profile: string,
    values: Record<string, string>,
  ): Promise<void> {
    const entries = Object.entries(values);
    const now = new Date().toISOString();
    await this.db.transaction(async (tx) => {
      await tx.delete(agentChannelCredentials)
        .where(and(
          eq(agentChannelCredentials.agentId, agentId),
          eq(agentChannelCredentials.channelType, channelType),
          eq(agentChannelCredentials.profile, profile),
        ));
      if (entries.length === 0) return;
      await tx.insert(agentChannelCredentials).values(
        entries.map(([key, value]) => ({
          agentId,
          channelType,
          profile,
          key,
          valueCiphertext: encrypt(this.key, value),
          createdAt: now,
          updatedAt: now,
        })),
      );
    });
  }

  async clear(
    agentId: string,
    channelType: string,
    profile: string,
  ): Promise<void> {
    await this.db.delete(agentChannelCredentials)
      .where(and(
        eq(agentChannelCredentials.agentId, agentId),
        eq(agentChannelCredentials.channelType, channelType),
        eq(agentChannelCredentials.profile, profile),
      ));
  }
}
