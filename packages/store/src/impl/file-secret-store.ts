import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { SecretEntry, SecretStore } from '../interfaces.js';

/**
 * File-backed implementation of SecretStore. Each agent has a
 * `<dataDir>/secrets.json` containing a flat string→entry map. This is
 * the legacy fallback when OPENHERMIT_SECRETS_KEY is unset; the
 * preferred path is DbSecretStore (encrypted, in postgres).
 *
 * Storage shape (current):
 *   { "NAME": { "value": "...", "passThrough": false }, ... }
 * For backward-compat we still parse the legacy plain-string shape
 *   { "NAME": "..." }
 * and treat those as `passThrough: false`.
 *
 * Lookups are by `agentId`; the file path is resolved through a
 * caller-supplied resolver — typically `resolveAgentDataDir(agentId)`.
 */
export type ConfigDirResolver = (agentId: string) => Promise<string>;

const readJsonSafe = async (filePath: string): Promise<Record<string, SecretEntry>> => {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, SecretEntry> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'string') {
        out[k] = { value: v, passThrough: false };
      } else if (v && typeof v === 'object' && typeof (v as { value?: unknown }).value === 'string') {
        out[k] = {
          value: (v as { value: string }).value,
          passThrough: (v as { passThrough?: unknown }).passThrough === true,
        };
      }
    }
    return out;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
};

const writeJsonAtomic = async (
  filePath: string,
  value: Record<string, SecretEntry>,
): Promise<void> => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const sorted: Record<string, SecretEntry> = {};
  for (const k of Object.keys(value).sort()) sorted[k] = value[k]!;
  await fs.writeFile(filePath, JSON.stringify(sorted, null, 2) + '\n', 'utf8');
};

export class FileSecretStore implements SecretStore {
  constructor(private readonly resolveConfigDir: ConfigDirResolver) {}

  private async pathFor(agentId: string): Promise<string> {
    const dir = await this.resolveConfigDir(agentId);
    return path.join(dir, 'secrets.json');
  }

  async list(agentId: string): Promise<Record<string, string>> {
    const entries = await this.listEntries(agentId);
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(entries)) out[k] = v.value;
    return out;
  }

  async listEntries(agentId: string): Promise<Record<string, SecretEntry>> {
    return readJsonSafe(await this.pathFor(agentId));
  }

  async get(agentId: string, name: string): Promise<string | undefined> {
    const all = await this.listEntries(agentId);
    return all[name]?.value;
  }

  async set(
    agentId: string,
    name: string,
    value: string,
    options?: { passThrough?: boolean },
  ): Promise<void> {
    const filePath = await this.pathFor(agentId);
    const all = await readJsonSafe(filePath);
    const existing = all[name];
    const passThrough = options?.passThrough ?? existing?.passThrough ?? false;
    all[name] = { value, passThrough };
    await writeJsonAtomic(filePath, all);
  }

  async delete(agentId: string, name: string): Promise<void> {
    const filePath = await this.pathFor(agentId);
    const all = await readJsonSafe(filePath);
    if (!(name in all)) return;
    delete all[name];
    await writeJsonAtomic(filePath, all);
  }

  async setAll(agentId: string, secrets: Record<string, string>): Promise<void> {
    const filePath = await this.pathFor(agentId);
    const out: Record<string, SecretEntry> = {};
    for (const [k, v] of Object.entries(secrets)) {
      out[k] = { value: v, passThrough: false };
    }
    await writeJsonAtomic(filePath, out);
  }
}
