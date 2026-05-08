import { drizzle } from 'drizzle-orm/node-postgres';
import { and, asc, eq } from 'drizzle-orm';
import pg from 'pg';

import type { SecretEntry, SecretStore } from '../interfaces.js';
import * as schema from '../schema.js';
import { agentSecrets } from '../schema.js';
import {
  decryptString as decrypt,
  encryptString as encrypt,
  secretsKeyFromEnv,
  generateSecretsKey,
} from './secret-crypto.js';
import type { DrizzleDb } from './index.js';

export { generateSecretsKey };

export class DbSecretStore implements SecretStore {
  private pool?: pg.Pool;

  private constructor(
    private readonly db: DrizzleDb,
    private readonly key: Buffer,
  ) {}

  /** Read OPENHERMIT_SECRETS_KEY from env. Throws if missing or malformed. */
  static keyFromEnv(env: NodeJS.ProcessEnv = process.env): Buffer {
    return secretsKeyFromEnv(env);
  }

  static async open(databaseUrl?: string): Promise<DbSecretStore> {
    const url = databaseUrl ?? process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL environment variable is required');
    const pool = new pg.Pool({ connectionString: url });
    await pool.query('SELECT 1');
    const db = drizzle(pool, { schema });
    const store = new DbSecretStore(db, secretsKeyFromEnv());
    store.pool = pool;
    return store;
  }

  static withDb(db: DrizzleDb): DbSecretStore {
    return new DbSecretStore(db, secretsKeyFromEnv());
  }

  async close(): Promise<void> {
    await this.pool?.end();
  }

  async list(agentId: string): Promise<Record<string, string>> {
    const entries = await this.listEntries(agentId);
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(entries)) out[k] = v.value;
    return out;
  }

  async listEntries(agentId: string): Promise<Record<string, SecretEntry>> {
    const rows = await this.db.select().from(agentSecrets)
      .where(eq(agentSecrets.agentId, agentId))
      .orderBy(asc(agentSecrets.name));
    const out: Record<string, SecretEntry> = {};
    for (const row of rows) {
      try {
        out[row.name] = {
          value: decrypt(this.key, row.valueCiphertext),
          passThrough: row.passThrough,
        };
      } catch {
        // Decryption failure — usually means the key changed. Skip the
        // entry rather than crash the whole list (admin can rotate /
        // re-set the secret manually).
      }
    }
    return out;
  }

  async get(agentId: string, name: string): Promise<string | undefined> {
    const [row] = await this.db.select().from(agentSecrets)
      .where(and(eq(agentSecrets.agentId, agentId), eq(agentSecrets.name, name)));
    if (!row) return undefined;
    try {
      return decrypt(this.key, row.valueCiphertext);
    } catch {
      return undefined;
    }
  }

  async set(
    agentId: string,
    name: string,
    value: string,
    options?: { passThrough?: boolean },
  ): Promise<void> {
    const ciphertext = encrypt(this.key, value);
    const now = new Date().toISOString();
    const passThrough = options?.passThrough;
    await this.db.insert(agentSecrets)
      .values({
        agentId,
        name,
        valueCiphertext: ciphertext,
        passThrough: passThrough ?? false,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [agentSecrets.agentId, agentSecrets.name],
        set: {
          valueCiphertext: ciphertext,
          updatedAt: now,
          // Only overwrite passThrough if caller explicitly set it; otherwise
          // preserve the existing flag on a value-only update.
          ...(passThrough !== undefined ? { passThrough } : {}),
        },
      });
  }

  async delete(agentId: string, name: string): Promise<void> {
    await this.db.delete(agentSecrets)
      .where(and(eq(agentSecrets.agentId, agentId), eq(agentSecrets.name, name)));
  }

  async setAll(agentId: string, secrets: Record<string, string>): Promise<void> {
    // Bulk replace: clear existing, then insert fresh ciphertexts. Simple
    // and correct; if you need atomic-ish behavior across replicas this
    // could move into a transaction.
    await this.db.delete(agentSecrets).where(eq(agentSecrets.agentId, agentId));
    if (Object.keys(secrets).length === 0) return;
    const now = new Date().toISOString();
    const rows = Object.entries(secrets).map(([name, value]) => ({
      agentId,
      name,
      valueCiphertext: encrypt(this.key, value),
      createdAt: now,
      updatedAt: now,
    }));
    await this.db.insert(agentSecrets).values(rows);
  }
}
