import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { TestContext } from 'node:test';

import type { AgentConfigStore, SecretStore } from '@openhermit/store';

import { AgentSecurity, AgentWorkspace, buildDefaultAgentConfig } from '../src/core/index.js';
import { DEFAULT_SECURITY_POLICY } from '../src/core/types.js';
import type { SecretsMap, SecurityPolicy } from '../src/core/types.js';

const uniqueAgentId = () => `agent-test-${randomBytes(4).toString('hex')}`;

/**
 * In-memory AgentConfigStore for tests. Holds config + security per
 * agentId in maps; no DB or filesystem required.
 */
class MemoryAgentConfigStore implements AgentConfigStore {
  private configs = new Map<string, Record<string, unknown>>();
  private security = new Map<string, Record<string, unknown>>();

  async getConfig(agentId: string): Promise<Record<string, unknown> | null> {
    return this.configs.get(agentId) ?? null;
  }
  async setConfig(agentId: string, config: Record<string, unknown>): Promise<void> {
    this.configs.set(agentId, config);
  }
  async getSecurity(agentId: string): Promise<Record<string, unknown> | null> {
    return this.security.get(agentId) ?? null;
  }
  async setSecurity(agentId: string, policy: Record<string, unknown>): Promise<void> {
    this.security.set(agentId, policy);
  }
  async getConfigPath(agentId: string, dotPath: string): Promise<unknown> {
    const doc = this.configs.get(agentId);
    if (!doc) return undefined;
    return dotPath.split('.').reduce<unknown>((acc, seg) => {
      if (acc === null || typeof acc !== 'object') return undefined;
      return (acc as Record<string, unknown>)[seg];
    }, doc);
  }
  async setConfigPath(): Promise<void> {
    throw new Error('not implemented in test stub');
  }
  async getSecurityPath(): Promise<unknown> {
    throw new Error('not implemented in test stub');
  }
  async setSecurityPath(): Promise<void> {
    throw new Error('not implemented in test stub');
  }
}

/**
 * In-memory SecretStore for tests.
 */
class MemorySecretStore implements SecretStore {
  private store = new Map<string, Record<string, { value: string; passThrough: boolean }>>();

  private bucket(agentId: string): Record<string, { value: string; passThrough: boolean }> {
    let m = this.store.get(agentId);
    if (!m) { m = {}; this.store.set(agentId, m); }
    return m;
  }
  async list(agentId: string): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(this.bucket(agentId))) out[k] = v.value;
    return out;
  }
  async listEntries(agentId: string): Promise<Record<string, { value: string; passThrough: boolean }>> {
    return { ...this.bucket(agentId) };
  }
  async get(agentId: string, name: string): Promise<string | undefined> {
    return this.bucket(agentId)[name]?.value;
  }
  async set(agentId: string, name: string, value: string, options?: { passThrough?: boolean }): Promise<void> {
    const existing = this.bucket(agentId)[name];
    this.bucket(agentId)[name] = {
      value,
      passThrough: options?.passThrough ?? existing?.passThrough ?? false,
    };
  }
  async delete(agentId: string, name: string): Promise<void> {
    delete this.bucket(agentId)[name];
  }
  async setAll(agentId: string, secrets: Record<string, string>): Promise<void> {
    const next: Record<string, { value: string; passThrough: boolean }> = {};
    for (const [k, v] of Object.entries(secrets)) next[k] = { value: v, passThrough: false };
    this.store.set(agentId, next);
  }
}

export interface WorkspaceFixture {
  root: string;
  agentId: string;
  workspace: AgentWorkspace;
}

export interface SecurityFixture extends WorkspaceFixture {
  security: AgentSecurity;
  configStore: AgentConfigStore;
  secretStore: SecretStore;
}

export const createTempDir = async (
  t: TestContext,
  prefix: string,
): Promise<string> => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });
  return directory;
};

export const createWorkspaceFixture = async (
  t: TestContext,
): Promise<WorkspaceFixture> => {
  const root = await createTempDir(t, 'openhermit-workspace-');
  const workspace = new AgentWorkspace(root);

  const agentId = uniqueAgentId();
  await workspace.init({
    agentId,
    createdAt: '2026-03-08T00:00:00.000Z',
  });

  return {
    root,
    agentId,
    workspace,
  };
};

export const createSecurityFixture = async (
  t: TestContext,
  options?: {
    secrets?: SecretsMap;
    /** Override fields in the seeded security policy. */
    security?: Partial<SecurityPolicy>;
    /** Skip seeding default config (for tests that want a missing-config error). */
    skipConfig?: boolean;
  },
): Promise<SecurityFixture> => {
  const workspaceFixture = await createWorkspaceFixture(t);

  const configStore = new MemoryAgentConfigStore();
  const secretStore = new MemorySecretStore();

  // Seed the default config + security policy unless test opts out.
  if (!options?.skipConfig) {
    await configStore.setConfig(
      workspaceFixture.agentId,
      buildDefaultAgentConfig(workspaceFixture.root) as unknown as Record<string, unknown>,
    );
  }
  await configStore.setSecurity(workspaceFixture.agentId, {
    ...DEFAULT_SECURITY_POLICY,
    ...(options?.security ?? {}),
  } as Record<string, unknown>);

  if (options?.secrets) {
    await secretStore.setAll(workspaceFixture.agentId, options.secrets);
  }

  const security = new AgentSecurity({
    agentId: workspaceFixture.agentId,
    workspace: workspaceFixture.workspace,
    configStore,
    secretStore,
  });

  return {
    ...workspaceFixture,
    security,
    configStore,
    secretStore,
  };
};
