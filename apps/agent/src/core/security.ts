import { z } from 'zod';

import { NotFoundError, ValidationError } from '@openhermit/shared';
import type { AgentConfigStore, SecretStore } from '@openhermit/store';

import type { ResolvePathOptions } from './workspace.js';
import { AgentWorkspace } from './workspace.js';
import {
  DEFAULT_SECURITY_POLICY,
  type AgentRuntimeConfig,
  type ChannelTokenEntry,
  type SecretsMap,
  type SecurityPolicy,
} from './types.js';

export interface AgentSecurityOptions {
  agentId: string;
  workspace: AgentWorkspace;
  configStore: AgentConfigStore;
  secretStore: SecretStore;
}

// ── Config schema (Zod) ───────────────────────────────────────────────────

const ModelConfigSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  max_tokens: z.number(),
  base_url: z.string().optional(),
  api: z.string().optional(),
  thinking: z.enum(['off', 'minimal', 'low', 'medium', 'high']).optional(),
});

const IntrospectionConfigSchema = z.object({
  enabled: z.boolean(),
  turn_interval: z.number(),
  passive_turn_interval: z.number(),
  idle_timeout_minutes: z.number(),
  max_tool_calls: z.number(),
  model: z.string().nullable(),
});

const MemoryConfigSchema = z.object({
  context_entry_limit: z.number().optional(),
  introspection: IntrospectionConfigSchema.optional(),
});

const LifecycleSchema = z.object({
  start: z.enum(['session', 'ondemand']).optional(),
  stop: z.enum(['session', 'idle']).optional(),
  idle_timeout_minutes: z.number().optional(),
});

const DockerBackendSchema = z.object({
  id: z.string().optional(),
  type: z.literal('docker'),
  label: z.string().optional(),
  image: z.string().min(1),
  memory_limit: z.string().optional(),
  cpu_shares: z.number().optional(),
  lifecycle: LifecycleSchema.optional(),
});

const HostBackendSchema = z.object({
  id: z.string().optional(),
  type: z.literal('host'),
  label: z.string().optional(),
  cwd: z.string().optional(),
  shell: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
});

const E2BBackendSchema = z.object({
  id: z.string().optional(),
  type: z.literal('e2b'),
  label: z.string().optional(),
  template: z.string().min(1),
  timeout_ms: z.number().optional(),
  sandbox_timeout_ms: z.number().optional(),
  cwd: z.string().optional(),
});

const ExecBackendConfigSchema = z.discriminatedUnion('type', [
  DockerBackendSchema,
  HostBackendSchema,
  E2BBackendSchema,
]);

const ExecConfigSchema = z.object({
  backends: z.array(ExecBackendConfigSchema),
  default_backend: z.string().optional(),
  lifecycle: LifecycleSchema.optional(),
});

const WebConfigSchema = z.object({
  provider: z.enum(['defuddle', 'exa', 'tavily']),
});

const TelegramChannelSchema = z.object({
  enabled: z.boolean(),
  bot_token: z.string().min(1),
  mode: z.enum(['polling', 'webhook']).optional(),
  webhook_url: z.string().optional(),
  webhook_port: z.number().optional(),
  allowed_chat_ids: z.array(z.string()).optional(),
});

const SlackChannelSchema = z.object({
  enabled: z.boolean(),
  bot_token: z.string().min(1),
  app_token: z.string().min(1),
  allowed_channel_ids: z.array(z.string()).optional(),
});

const DiscordChannelSchema = z.object({
  enabled: z.boolean(),
  bot_token: z.string().min(1),
  allowed_channel_ids: z.array(z.string()).optional(),
});

const ChannelsConfigSchema = z.object({
  telegram: TelegramChannelSchema.optional(),
  slack: SlackChannelSchema.optional(),
  discord: DiscordChannelSchema.optional(),
});

const AgentRuntimeConfigSchema = z.object({
  workspace_root: z.string(),
  model: ModelConfigSchema,
  memory: MemoryConfigSchema,
  exec: ExecConfigSchema.optional(),
  web: WebConfigSchema.optional(),
  channels: ChannelsConfigSchema.optional(),
});

function validateConfig(config: unknown, filePath: string): asserts config is AgentRuntimeConfig {
  const result = AgentRuntimeConfigSchema.safeParse(config);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new ValidationError(`Invalid config in ${filePath}:\n${issues}`);
  }
}

export class AgentSecurity {
  private policy: SecurityPolicy = DEFAULT_SECURITY_POLICY;

  private secrets: SecretsMap = {};

  readonly agentId: string;

  private readonly configStore: AgentConfigStore;

  private readonly secretStore: SecretStore;

  constructor(private readonly options: AgentSecurityOptions) {
    this.agentId = options.agentId;
    this.configStore = options.configStore;
    this.secretStore = options.secretStore;
  }

  async load(): Promise<void> {
    const [policyDoc, secretsMap] = await Promise.all([
      this.configStore.getSecurity(this.agentId),
      this.secretStore.list(this.agentId),
    ]);

    const parsedPolicy = (policyDoc ?? DEFAULT_SECURITY_POLICY) as SecurityPolicy;

    const channelTokens: ChannelTokenEntry[] = [];
    if (Array.isArray(parsedPolicy.channel_tokens)) {
      for (const entry of parsedPolicy.channel_tokens) {
        if (
          entry &&
          typeof entry === 'object' &&
          typeof (entry as ChannelTokenEntry).channel === 'string' &&
          typeof (entry as ChannelTokenEntry).token === 'string'
        ) {
          channelTokens.push({
            channel: (entry as ChannelTokenEntry).channel,
            token: (entry as ChannelTokenEntry).token,
          });
        }
      }
    }

    this.policy = {
      ...(parsedPolicy.access ? { access: parsedPolicy.access } : {}),
      ...(parsedPolicy.access_token ? { access_token: parsedPolicy.access_token } : {}),
      ...(channelTokens.length > 0 ? { channel_tokens: channelTokens } : {}),
    };

    const sanitizedSecrets: SecretsMap = {};
    for (const [key, value] of Object.entries(secretsMap)) {
      if (typeof value !== 'string') {
        throw new ValidationError(`Secret value must be a string: ${key}`);
      }
      sanitizedSecrets[key] = value;
    }
    this.secrets = sanitizedSecrets;
  }

  checkPath(relativePath: string, options?: ResolvePathOptions): Promise<string> {
    return this.options.workspace.resolve(relativePath, options);
  }

  getAccessLevel(): import('./types.js').AgentAccessLevel {
    return this.policy.access ?? 'public';
  }

  getAccessToken(): string | undefined {
    return this.policy.access_token;
  }

  getChannelTokens(): ChannelTokenEntry[] {
    return this.policy.channel_tokens ?? [];
  }

  resolveSecrets(names: string[]): Record<string, string> {
    const resolved: Record<string, string> = {};

    for (const name of names) {
      const value = this.secrets[name];

      if (value === undefined) {
        throw new NotFoundError(`Secret not found: ${name}`);
      }

      resolved[name] = value;
    }

    return resolved;
  }

  listSecretNames(): string[] {
    return Object.keys(this.secrets).sort();
  }

  /** Return the full secrets map (admin use only). */
  async readSecrets(): Promise<SecretsMap> {
    return this.secretStore.list(this.agentId);
  }

  /**
   * Return the subset of secrets flagged with `passThrough: true`, as a
   * plain env-var map. Used by the agent runner to inject these into
   * every exec backend so tools running inside the sandbox can read them
   * via process.env. Returns an empty map when no secrets are flagged.
   */
  async getPassThroughEnv(): Promise<Record<string, string>> {
    const entries = await this.secretStore.listEntries(this.agentId);
    const out: Record<string, string> = {};
    for (const [name, entry] of Object.entries(entries)) {
      if (entry.passThrough) out[name] = entry.value;
    }
    return out;
  }

  async readConfig(): Promise<AgentRuntimeConfig> {
    // Reload policy + secrets on every config read so changes take
    // effect without an agent restart.
    await this.load();
    const raw = await this.requireConfigDoc();
    validateConfig(raw, `agents.${this.agentId}.config`);
    return this.interpolateSecrets(raw);
  }

  /** Read config without resolving ${{SECRET}} placeholders. */
  async readRawConfig(): Promise<AgentRuntimeConfig> {
    const raw = await this.requireConfigDoc();
    validateConfig(raw, `agents.${this.agentId}.config`);
    return raw;
  }

  async readSecurityPolicy(): Promise<SecurityPolicy> {
    await this.load();
    return { ...this.policy };
  }

  async writeSecurityPolicy(policy: SecurityPolicy): Promise<void> {
    await this.configStore.setSecurity(this.agentId, policy as unknown as Record<string, unknown>);
    await this.load();
  }

  private async requireConfigDoc(): Promise<unknown> {
    const doc = await this.configStore.getConfig(this.agentId);
    if (!doc) {
      throw new ValidationError(
        `Agent config missing for ${this.agentId}.`,
      );
    }
    return doc;
  }

  /**
   * Public entry-point for callers (e.g. the channel-row loader in
   * agent-instance.ts) that hold a raw config blob and need secret
   * placeholders resolved without going through readConfig.
   */
  async expandSecrets<T>(value: T): Promise<T> {
    await this.load();
    return this.interpolateSecrets(value);
  }

  /**
   * Recursively replace `${{SECRET_NAME}}` placeholders in string values
   * with the corresponding secret. Unknown secret names are left as-is.
   */
  private interpolateSecrets<T>(value: T): T {
    if (typeof value === 'string') {
      return value.replace(/\$\{\{(\w+)\}\}/g, (_match, name: string) => {
        return this.secrets[name] ?? _match;
      }) as T;
    }
    if (Array.isArray(value)) {
      return value.map((item) => this.interpolateSecrets(item)) as T;
    }
    if (value !== null && typeof value === 'object') {
      const result: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) {
        result[k] = this.interpolateSecrets(v);
      }
      return result as T;
    }
    return value;
  }

  async writeConfig(config: AgentRuntimeConfig): Promise<void> {
    await this.configStore.setConfig(this.agentId, config as unknown as Record<string, unknown>);
  }
}
