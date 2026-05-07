import fs from 'node:fs/promises';

import type { DbMetaStore } from '@openhermit/store';

export interface SandboxPreset {
  type: 'host' | 'docker' | 'e2b' | 'daytona';
  /** Backend-specific config (image/snapshot/template, agent_home, etc.). */
  config: Record<string, unknown>;
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

  return {
    ui: typeof raw.ui === 'boolean' ? raw.ui : DEFAULT_CONFIG.ui,
    cors: {
      origin: getCorsOrigin(raw) ?? DEFAULT_CONFIG.cors.origin,
    },
    sandboxPresets: presets,
    autoProvisionSandbox: autoProvision,
  };
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
