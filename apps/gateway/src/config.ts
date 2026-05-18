import fs from 'node:fs/promises';

import type { DbMetaStore } from '@openhermit/store';

export interface SandboxPreset {
  type: 'host' | 'docker' | 'e2b' | 'daytona';
  /** Backend-specific config (image/snapshot/template, agent_home, etc.). */
  config: Record<string, unknown>;
}

/**
 * Backend selector + non-secret pointers for attachment byte storage.
 * Credentials are NEVER stored here — AWS uses the default credential
 * chain (env / IAM); Supabase reads `SUPABASE_SERVICE_ROLE_KEY` from env.
 */
export type AttachmentStorageConfig =
  | { provider: 'local'; root?: string }
  | {
      provider: 's3';
      bucket: string;
      region?: string;
      prefix?: string;
      endpoint?: string;
      forcePathStyle?: boolean;
      signedUrlExpiresIn?: number;
    }
  | {
      provider: 'supabase';
      url: string;
      bucket: string;
      prefix?: string;
      signedUrlExpiresIn?: number;
    };

export interface AttachmentsConfig {
  storage: AttachmentStorageConfig;
  limits?: {
    maxBytes?: number;
    sandboxCopyMaxBytes?: number;
  };
}

export interface GatewayConfig {
  ui: boolean;
  cors: { origin: string };
  /** Named sandbox presets, keyed by preset name. */
  sandboxPresets: Record<string, SandboxPreset>;
  /**
   * Name of the preset to auto-provision when an agent is created without an
   * explicit `sandbox` field. `null` (or missing) disables auto-provisioning.
   */
  autoProvisionSandbox: string | null;
  /**
   * Additional channel packages to dynamic-import at gateway boot. Each
   * package must default-export a `ChannelManifest`. External packages
   * may override a built-in channel by matching its key.
   */
  channelPackages: string[];
  /**
   * Optional attachment storage configuration. When omitted, the gateway
   * defaults to local-disk storage rooted at
   * `OPENHERMIT_ATTACHMENT_ROOT` (or `~/.openhermit/attachments`).
   */
  attachments?: AttachmentsConfig;
}

export const META_KEY = 'gateway.config';

const DEFAULT_PRESETS: Record<string, SandboxPreset> = {
  'docker-ubuntu': {
    type: 'docker',
    config: { image: 'ubuntu:24.04', username: 'root', agent_home: '/root' },
  },
};

const DEFAULT_CONFIG: GatewayConfig = {
  ui: true,
  cors: { origin: '*' },
  sandboxPresets: DEFAULT_PRESETS,
  autoProvisionSandbox: 'docker-ubuntu',
  channelPackages: [],
};

export const defaultGatewayConfig = (): GatewayConfig =>
  JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as GatewayConfig;

const SUPPORTED_TYPES = new Set(['host', 'docker', 'e2b', 'daytona']);

const getCorsOrigin = (raw: Record<string, unknown>): string | undefined => {
  if (raw.cors && typeof raw.cors === 'object') {
    const origin = (raw.cors as Record<string, unknown>).origin;
    if (typeof origin === 'string') return origin;
  }
  return undefined;
};

const parsePresets = (raw: unknown): Record<string, SandboxPreset> | undefined => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: Record<string, SandboxPreset> = {};
  for (const [name, val] of Object.entries(raw as Record<string, unknown>)) {
    if (!val || typeof val !== 'object') {
      throw new Error(`Invalid sandboxPresets["${name}"]: must be an object`);
    }
    const v = val as Record<string, unknown>;
    const type = v['type'];
    if (typeof type !== 'string' || !SUPPORTED_TYPES.has(type)) {
      throw new Error(`Invalid sandboxPresets["${name}"].type: ${String(type)}`);
    }
    const config = v['config'] && typeof v['config'] === 'object' && !Array.isArray(v['config'])
      ? (v['config'] as Record<string, unknown>)
      : {};
    out[name] = { type: type as SandboxPreset['type'], config };
  }
  return out;
};

const parseChannelPackages = (raw: unknown): string[] => {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new Error('channelPackages must be an array of package name strings');
  }
  return raw.map((v, i) => {
    if (typeof v !== 'string' || v.trim() === '') {
      throw new Error(`channelPackages[${i}] must be a non-empty string`);
    }
    return v.trim();
  });
};

const ATTACHMENT_PROVIDERS = new Set(['local', 's3', 'supabase']);

const optionalString = (raw: unknown, field: string): string | undefined => {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string') {
    throw new Error(`attachments.storage.${field} must be a string`);
  }
  return raw;
};

const optionalPositiveInt = (raw: unknown, field: string): number | undefined => {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0 || !Number.isInteger(raw)) {
    throw new Error(`${field} must be a positive integer`);
  }
  return raw;
};

const optionalBoolean = (raw: unknown, field: string): boolean | undefined => {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'boolean') throw new Error(`${field} must be a boolean`);
  return raw;
};

const parseAttachmentsConfig = (raw: unknown): AttachmentsConfig | undefined => {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('attachments must be an object');
  }
  const obj = raw as Record<string, unknown>;
  const storageRaw = obj['storage'];
  if (!storageRaw || typeof storageRaw !== 'object' || Array.isArray(storageRaw)) {
    throw new Error('attachments.storage must be an object');
  }
  const storage = storageRaw as Record<string, unknown>;
  const provider = storage['provider'];
  if (typeof provider !== 'string' || !ATTACHMENT_PROVIDERS.has(provider)) {
    throw new Error(
      `attachments.storage.provider must be one of: ${[...ATTACHMENT_PROVIDERS].join(', ')}`,
    );
  }

  let parsedStorage: AttachmentStorageConfig;
  if (provider === 'local') {
    parsedStorage = { provider: 'local' };
    const root = optionalString(storage['root'], 'root');
    if (root !== undefined) parsedStorage.root = root;
  } else if (provider === 's3') {
    const bucket = storage['bucket'];
    if (typeof bucket !== 'string' || bucket === '') {
      throw new Error('attachments.storage.bucket is required when provider=s3');
    }
    parsedStorage = { provider: 's3', bucket };
    const region = optionalString(storage['region'], 'region');
    if (region !== undefined) parsedStorage.region = region;
    const prefix = optionalString(storage['prefix'], 'prefix');
    if (prefix !== undefined) parsedStorage.prefix = prefix;
    const endpoint = optionalString(storage['endpoint'], 'endpoint');
    if (endpoint !== undefined) parsedStorage.endpoint = endpoint;
    const forcePathStyle = optionalBoolean(
      storage['forcePathStyle'],
      'attachments.storage.forcePathStyle',
    );
    if (forcePathStyle !== undefined) parsedStorage.forcePathStyle = forcePathStyle;
    const signedExp = optionalPositiveInt(
      storage['signedUrlExpiresIn'],
      'attachments.storage.signedUrlExpiresIn',
    );
    if (signedExp !== undefined) parsedStorage.signedUrlExpiresIn = signedExp;
  } else {
    // supabase
    const url = storage['url'];
    const bucket = storage['bucket'];
    if (typeof url !== 'string' || url === '') {
      throw new Error('attachments.storage.url is required when provider=supabase');
    }
    if (typeof bucket !== 'string' || bucket === '') {
      throw new Error('attachments.storage.bucket is required when provider=supabase');
    }
    parsedStorage = { provider: 'supabase', url, bucket };
    const prefix = optionalString(storage['prefix'], 'prefix');
    if (prefix !== undefined) parsedStorage.prefix = prefix;
    const signedExp = optionalPositiveInt(
      storage['signedUrlExpiresIn'],
      'attachments.storage.signedUrlExpiresIn',
    );
    if (signedExp !== undefined) parsedStorage.signedUrlExpiresIn = signedExp;
  }

  const result: AttachmentsConfig = { storage: parsedStorage };
  const limitsRaw = obj['limits'];
  if (limitsRaw !== undefined && limitsRaw !== null) {
    if (typeof limitsRaw !== 'object' || Array.isArray(limitsRaw)) {
      throw new Error('attachments.limits must be an object');
    }
    const limits = limitsRaw as Record<string, unknown>;
    const maxBytes = optionalPositiveInt(limits['maxBytes'], 'attachments.limits.maxBytes');
    const sandboxCopyMaxBytes = optionalPositiveInt(
      limits['sandboxCopyMaxBytes'],
      'attachments.limits.sandboxCopyMaxBytes',
    );
    if (maxBytes !== undefined || sandboxCopyMaxBytes !== undefined) {
      result.limits = {};
      if (maxBytes !== undefined) result.limits.maxBytes = maxBytes;
      if (sandboxCopyMaxBytes !== undefined) result.limits.sandboxCopyMaxBytes = sandboxCopyMaxBytes;
    }
  }
  return result;
};

const parseAutoProvision = (
  raw: unknown,
  presets: Record<string, SandboxPreset>,
): string | null => {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'string') {
    throw new Error(
      'autoProvisionSandbox must be a string preset name (or null). ' +
        'The legacy { enabled, type, config } shape is no longer supported — ' +
        'move the config into `sandboxPresets` and reference it by name.',
    );
  }
  if (!presets[raw]) {
    throw new Error(
      `autoProvisionSandbox references unknown preset "${raw}". ` +
        `Known presets: ${Object.keys(presets).join(', ') || '(none)'}`,
    );
  }
  return raw;
};

/**
 * Validate a raw config object (e.g. from JSON file or DB) and return
 * a fully-populated GatewayConfig with defaults applied.
 */
export const parseGatewayConfig = (raw: Record<string, unknown>): GatewayConfig => {
  const presets = parsePresets(raw['sandboxPresets']) ?? defaultGatewayConfig().sandboxPresets;
  const autoProvision = 'autoProvisionSandbox' in raw
    ? parseAutoProvision(raw['autoProvisionSandbox'], presets)
    : DEFAULT_CONFIG.autoProvisionSandbox;

  const out: GatewayConfig = {
    ui: typeof raw.ui === 'boolean' ? raw.ui : DEFAULT_CONFIG.ui,
    cors: {
      origin: getCorsOrigin(raw) ?? DEFAULT_CONFIG.cors.origin,
    },
    sandboxPresets: presets,
    autoProvisionSandbox: autoProvision,
    channelPackages: parseChannelPackages(raw['channelPackages']),
  };
  const attachments = parseAttachmentsConfig(raw['attachments']);
  if (attachments) out.attachments = attachments;
  return out;
};

const readFileIfExists = async (filePath: string): Promise<Record<string, unknown> | null> => {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(content) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    throw new Error(`gateway config at ${filePath} must be a JSON object`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`Failed to read gateway config: ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
  }
};

/**
 * Load gateway config, preferring the DB when a meta store is provided.
 *
 * Migration: if the DB has no entry but the file exists, copy the file
 * contents into the DB and rename the file to `<file>.imported`. This is
 * idempotent across boots.
 *
 * Without a meta store (e.g. no DATABASE_URL), falls back to file or defaults.
 */
export const loadGatewayConfig = async (
  filePath: string,
  options: { metaStore?: DbMetaStore } = {},
): Promise<{ config: GatewayConfig; source: 'db' | 'file' | 'defaults' }> => {
  const { metaStore } = options;

  if (metaStore) {
    const dbRaw = await metaStore.getJson<Record<string, unknown>>(META_KEY);
    if (dbRaw && typeof dbRaw === 'object' && !Array.isArray(dbRaw)) {
      return { config: parseGatewayConfig(dbRaw), source: 'db' };
    }

    // DB empty — try to migrate from file.
    const fileRaw = await readFileIfExists(filePath);
    if (fileRaw) {
      // Validate before persisting to surface bad files loudly.
      const parsed = parseGatewayConfig(fileRaw);
      await metaStore.setJson(META_KEY, fileRaw);
      await fs.rename(filePath, `${filePath}.imported`).catch(() => undefined);
      return { config: parsed, source: 'db' };
    }

    return { config: defaultGatewayConfig(), source: 'defaults' };
  }

  const fileRaw = await readFileIfExists(filePath);
  if (fileRaw) return { config: parseGatewayConfig(fileRaw), source: 'file' };
  return { config: defaultGatewayConfig(), source: 'defaults' };
};

/**
 * Validate-then-persist a full config document to the meta store.
 * Returns the parsed config that was actually saved (with defaults applied).
 */
export const saveGatewayConfig = async (
  metaStore: DbMetaStore,
  raw: Record<string, unknown>,
): Promise<GatewayConfig> => {
  const parsed = parseGatewayConfig(raw);
  await metaStore.setJson(META_KEY, raw);
  return parsed;
};
