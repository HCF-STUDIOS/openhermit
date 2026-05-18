import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';

import type { InternalStateStore } from '../interfaces.js';
import * as schema from '../schema.js';
import { DbSessionStore } from './session-store.js';
import { DbMessageStore } from './message-store.js';
import { DbMemoryProvider } from './memory-provider.js';
import { DbInstructionStore } from './instruction-store.js';
import { DbUserStore } from './user-store.js';
import { DbAgentStore } from './agent-store.js';
import { DbScheduleStore } from './schedule-store.js';

export type DrizzleDb = ReturnType<typeof drizzle<typeof schema>>;

export function createDb(pool: pg.Pool) {
  return drizzle(pool, { schema });
}

export class DbInternalStateStore implements InternalStateStore {
  readonly sessions: DbSessionStore;
  readonly messages: DbMessageStore;
  readonly memories: DbMemoryProvider;
  readonly instructions: DbInstructionStore;
  readonly users: DbUserStore;
  readonly schedules: DbScheduleStore;

  private constructor(
    private readonly pool: pg.Pool,
    db: DrizzleDb,
  ) {
    this.sessions = new DbSessionStore(db);
    this.messages = new DbMessageStore(db);
    this.memories = new DbMemoryProvider(db);
    this.instructions = new DbInstructionStore(db);
    this.users = new DbUserStore(db);
    this.schedules = new DbScheduleStore(db);
  }

  static async open(databaseUrl?: string): Promise<DbInternalStateStore> {
    const url = databaseUrl ?? process.env.DATABASE_URL;
    if (!url) {
      throw new Error('DATABASE_URL environment variable is required');
    }

    const pool = new pg.Pool({ connectionString: url });
    await pool.query('SELECT 1');
    const db = createDb(pool);
    return new DbInternalStateStore(pool, db);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export { DbSessionStore } from './session-store.js';
export { DbMessageStore } from './message-store.js';
export { DbMemoryProvider } from './memory-provider.js';
export { DbInstructionStore } from './instruction-store.js';
export { DbUserStore } from './user-store.js';
export { DbAgentStore } from './agent-store.js';
export { DbSkillStore } from './skill-store.js';
export { DbScheduleStore } from './schedule-store.js';
export { DbMcpServerStore } from './mcp-server-store.js';
export { DbAgentConfigStore } from './agent-config-store.js';
export { DbSandboxStore } from './sandbox-store.js';
export { DbPolicyStore } from './policy-store.js';
export { DbApprovalRequestStore } from './approval-request-store.js';
export { DbAttachmentStore } from './attachment-store.js';
export {
  LocalAttachmentStorage,
  type LocalAttachmentStorageOptions,
} from './local-attachment-storage.js';
export {
  S3AttachmentStorage,
  type S3AttachmentStorageOptions,
} from './s3-attachment-storage.js';
export {
  SupabaseAttachmentStorage,
  type SupabaseAttachmentStorageOptions,
} from './supabase-attachment-storage.js';
export { FileSecretStore, type ConfigDirResolver } from './file-secret-store.js';
export { DbSecretStore, generateSecretsKey } from './db-secret-store.js';
export {
  DbAgentChannelStore,
  type AgentChannelRow,
  type CreatedAgentChannel,
  type AgentChannelLoaded,
} from './db-agent-channel-store.js';
export { runMigrations } from './migrator.js';
export { DbMetaStore } from './meta-store.js';
