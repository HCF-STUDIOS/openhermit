import crypto from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import pg from 'pg';

import * as schema from '../schema.js';
import { agentChannels } from '../schema.js';
import {
  decryptString as decrypt,
  encryptString as encrypt,
  secretsKeyFromEnv,
} from './secret-crypto.js';
import type { DrizzleDb } from './index.js';

/**
 * Per-agent channel registrations: built-in adapters (telegram/discord/slack
 * running in-process) and owner-issued external channels. Each row owns a
 * token; for builtin rows the token still goes through ChannelRegistry so
 * the in-process bridge can call the gateway with the same auth flow as an
 * external adapter would.
 *
 * Encryption key is OPENHERMIT_SECRETS_KEY — same key as DbSecretStore;
 * losing it means losing every channel token along with every agent secret.
 */
export type ChannelKind = 'builtin' | 'external';

export interface AgentChannelRow {
  id: string;
  agentId: string;
  kind: ChannelKind;
  channelType: string;
  namespace: string;
  label: string | null;
  enabled: boolean;
  config: Record<string, unknown>;
  tokenPrefix: string;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  /** ISO timestamp of the most recent successful upstream interaction. */
  lastSuccessAt: string | null;
  /** Consecutive failures since the last recorded success. */
  consecutiveFailureCount: number;
  /** Monotonic total failures — never reset. */
  totalFailureCount: number;
}

export interface CreatedAgentChannel extends AgentChannelRow {
  /** Plaintext token. Returned ONLY at creation; never re-derivable from list/get. */
  token: string;
}

export interface AgentChannelLoaded {
  id: string;
  agentId: string;
  kind: ChannelKind;
  channelType: string;
  namespace: string;
  enabled: boolean;
  config: Record<string, unknown>;
  /** Decrypted plaintext, used by the gateway to seed ChannelRegistry at boot. */
  token: string;
}

const CHANNEL_TOKEN_PREFIX = 'oh_ch_';

const generateChannelToken = (): string =>
  CHANNEL_TOKEN_PREFIX + crypto.randomBytes(24).toString('hex');

const generateChannelId = (): string =>
  `chr-${crypto.randomBytes(8).toString('hex')}`;

export class DbAgentChannelStore {
  private pool?: pg.Pool;

  private constructor(
    private readonly db: DrizzleDb,
    private readonly key: Buffer,
  ) {}

  static async open(databaseUrl?: string): Promise<DbAgentChannelStore> {
    const url = databaseUrl ?? process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL environment variable is required');
    const pool = new pg.Pool({ connectionString: url });
    await pool.query('SELECT 1');
    const db = drizzle(pool, { schema });
    const store = new DbAgentChannelStore(db, secretsKeyFromEnv());
    store.pool = pool;
    return store;
  }

  static withDb(db: DrizzleDb): DbAgentChannelStore {
    return new DbAgentChannelStore(db, secretsKeyFromEnv());
  }

  async close(): Promise<void> {
    await this.pool?.end();
  }

  /**
   * Create a new external (owner-registered) channel. Returns the row +
   * plaintext token (only visible here).
   */
  async createExternal(input: {
    agentId: string;
    namespace: string;
    label?: string;
    config?: Record<string, unknown>;
    enabled?: boolean;
    createdBy?: string;
  }): Promise<CreatedAgentChannel> {
    return this.createRow({
      ...input,
      kind: 'external',
      channelType: input.namespace,
    });
  }

  /**
   * Create a built-in channel slot for an agent. Used by the create-agent
   * flow to pre-seed one row per supported builtin (telegram/discord/slack),
   * all initially disabled.
   */
  async createBuiltin(input: {
    agentId: string;
    channelType: string;
    label?: string;
    config?: Record<string, unknown>;
    enabled?: boolean;
  }): Promise<CreatedAgentChannel> {
    return this.createRow({
      ...input,
      kind: 'builtin',
      namespace: input.channelType,
    });
  }

  private async createRow(input: {
    agentId: string;
    kind: ChannelKind;
    channelType: string;
    namespace: string;
    label?: string;
    config?: Record<string, unknown>;
    enabled?: boolean;
    createdBy?: string;
  }): Promise<CreatedAgentChannel> {
    const id = generateChannelId();
    const token = generateChannelToken();
    const tokenPrefix = token.slice(0, 12);
    const tokenCiphertext = encrypt(this.key, token);
    const now = new Date().toISOString();
    const config = input.config ?? {};
    const enabled = input.enabled ?? false;

    await this.db.insert(agentChannels).values({
      id,
      agentId: input.agentId,
      kind: input.kind,
      channelType: input.channelType,
      namespace: input.namespace,
      label: input.label ?? null,
      enabled,
      config,
      tokenPrefix,
      tokenCiphertext,
      createdBy: input.createdBy ?? null,
      createdAt: now,
      updatedAt: now,
    });

    return {
      id,
      agentId: input.agentId,
      kind: input.kind,
      channelType: input.channelType,
      namespace: input.namespace,
      label: input.label ?? null,
      enabled,
      config,
      tokenPrefix,
      createdBy: input.createdBy ?? null,
      createdAt: now,
      updatedAt: now,
      lastUsedAt: null,
      revokedAt: null,
      lastError: null,
      lastErrorAt: null,
      lastSuccessAt: null,
      consecutiveFailureCount: 0,
      totalFailureCount: 0,
      token,
    };
  }

  /** All non-revoked channels (both kinds) for an agent. */
  async listForAgent(agentId: string): Promise<AgentChannelRow[]> {
    const rows = await this.db.select().from(agentChannels)
      .where(and(eq(agentChannels.agentId, agentId), isNull(agentChannels.revokedAt)))
      .orderBy(asc(agentChannels.kind), asc(agentChannels.channelType), asc(agentChannels.createdAt));
    return rows.map(rowToPublic);
  }

  /** Find an active builtin row by (agentId, channelType). */
  async findBuiltin(agentId: string, channelType: string): Promise<AgentChannelRow | undefined> {
    const [row] = await this.db.select().from(agentChannels)
      .where(and(
        eq(agentChannels.agentId, agentId),
        eq(agentChannels.kind, 'builtin'),
        eq(agentChannels.channelType, channelType),
        isNull(agentChannels.revokedAt),
      ));
    return row ? rowToPublic(row) : undefined;
  }

  async get(id: string): Promise<AgentChannelRow | undefined> {
    const [row] = await this.db.select().from(agentChannels).where(eq(agentChannels.id, id));
    return row ? rowToPublic(row) : undefined;
  }

  /**
   * Patch enabled / label / config on an existing channel. Returns the
   * updated row (or undefined if missing).
   */
  async update(id: string, patch: {
    enabled?: boolean;
    label?: string | null;
    config?: Record<string, unknown>;
  }): Promise<AgentChannelRow | undefined> {
    const data: Record<string, unknown> = { updatedAt: new Date().toISOString() };
    if (patch.enabled !== undefined) data.enabled = patch.enabled;
    if (patch.label !== undefined) data.label = patch.label;
    if (patch.config !== undefined) data.config = patch.config;

    const [row] = await this.db.update(agentChannels).set(data)
      .where(eq(agentChannels.id, id))
      .returning();
    return row ? rowToPublic(row) : undefined;
  }

  /**
   * Record a runtime error for the channel. Sets `last_error` /
   * `last_error_at` and bumps the failure counters. The channel keeps any
   * existing `last_success_at` — counters and success timestamps live
   * independently so postmortems can answer "how many failures preceded
   * the last recovery?".
   */
  async recordError(id: string, error: string): Promise<void> {
    await this.db.update(agentChannels)
      .set({
        lastError: error,
        lastErrorAt: new Date().toISOString(),
        consecutiveFailureCount: sql`${agentChannels.consecutiveFailureCount} + 1`,
        totalFailureCount: sql`${agentChannels.totalFailureCount} + 1`,
      })
      .where(eq(agentChannels.id, id));
  }

  /**
   * Record a successful upstream interaction (poll-success, webhook
   * delivery accepted, connection re-opened, …). Clears `last_error` /
   * `last_error_at`, resets `consecutive_failure_count`, and stamps
   * `last_success_at`. Cheap to call on every iteration — the gateway's
   * channel pool already dedupes consecutive identical reports before
   * reaching this layer.
   */
  async recordSuccess(id: string): Promise<void> {
    await this.db.update(agentChannels)
      .set({
        lastError: null,
        lastErrorAt: null,
        lastSuccessAt: new Date().toISOString(),
        consecutiveFailureCount: 0,
      })
      .where(eq(agentChannels.id, id));
  }

  /**
   * Clear `last_error` without claiming a success. Used when the
   * operator/user disables or removes the channel — the stored error is no
   * longer actionable, but we have no reason to advance `last_success_at`.
   */
  async clearError(id: string): Promise<void> {
    await this.db.update(agentChannels)
      .set({ lastError: null, lastErrorAt: null })
      .where(eq(agentChannels.id, id));
  }

  /** Soft-delete: mark revoked so it stops resolving. */
  async revoke(id: string): Promise<void> {
    await this.db.update(agentChannels)
      .set({ revokedAt: new Date().toISOString(), enabled: false })
      .where(eq(agentChannels.id, id));
  }

  /** Hard-delete (used for builtin slots that owner truly wants gone). */
  async delete(id: string): Promise<void> {
    await this.db.delete(agentChannels).where(eq(agentChannels.id, id));
  }

  /**
   * Decrypt every active channel token for boot-time loading into
   * ChannelRegistry. Includes both kinds. Decryption failures (e.g. key
   * rotated) are skipped silently.
   */
  async loadActive(): Promise<AgentChannelLoaded[]> {
    const rows = await this.db.select().from(agentChannels)
      .where(isNull(agentChannels.revokedAt));
    const out: AgentChannelLoaded[] = [];
    for (const row of rows) {
      try {
        const token = decrypt(this.key, row.tokenCiphertext);
        out.push({
          id: row.id,
          agentId: row.agentId,
          kind: row.kind as ChannelKind,
          channelType: row.channelType,
          namespace: row.namespace,
          enabled: row.enabled,
          config: (row.config ?? {}) as Record<string, unknown>,
          token,
        });
      } catch {
        // skip
      }
    }
    return out;
  }
}

const rowToPublic = (row: typeof agentChannels.$inferSelect): AgentChannelRow => ({
  id: row.id,
  agentId: row.agentId,
  kind: row.kind as ChannelKind,
  channelType: row.channelType,
  namespace: row.namespace,
  label: row.label,
  enabled: row.enabled,
  config: (row.config ?? {}) as Record<string, unknown>,
  tokenPrefix: row.tokenPrefix,
  createdBy: row.createdBy,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  lastUsedAt: row.lastUsedAt,
  revokedAt: row.revokedAt,
  lastError: row.lastError,
  lastErrorAt: row.lastErrorAt,
  lastSuccessAt: row.lastSuccessAt,
  consecutiveFailureCount: row.consecutiveFailureCount,
  totalFailureCount: row.totalFailureCount,
});
