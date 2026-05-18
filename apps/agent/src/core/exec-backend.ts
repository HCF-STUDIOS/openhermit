import { NotFoundError, ValidationError } from '@openhermit/shared';

import type { ContainerProcessResult, WorkspaceContainerLifecycle } from './types.js';
import type { DockerContainerManager } from './container-manager.js';

// Re-export file backend types so existing `import from '../core/index.js'` still works.
export type {
  FileBackend,
  FileWriteMode,
  DirEntry,
  FileStat,
  FileReadResult,
} from './backends/file-backend.js';

// ── Result type ──────────────────────────────────────────────────────────

export type ExecResult = ContainerProcessResult;

// ── Backend interface ────────────────────────────────────────────────────

export interface SyncSkillEntry {
  /** Skill folder name; becomes the basename of the synced directory. */
  id: string;
  /** Absolute path on the gateway host to copy from. */
  sourcePath: string;
  /**
   * Selects the subdir under `<agentHome>/.openhermit/skills/`:
   *   'system' → skills/system/<id>
   *   'user'   → skills/user/<id>
   * Kept as a discriminator (rather than letting callers pass the path) so the
   * agent can only see/install into the layouts the runner authorizes.
   */
  source: 'system' | 'user';
}

export interface ExecOpts {
  cwd?: string;
}

export interface ExecBackend {
  readonly id: string;
  readonly type: string;
  readonly label: string;
  /** Linux username commands run as inside this backend. */
  readonly username: string;
  /** Path that maps to the agent's workspace inside the exec env. */
  readonly agentHome: string;
  /** Idempotent setup (start container, etc.). */
  ensure(): Promise<void>;
  /** Execute a shell command and return the result. */
  exec(command: string, opts?: ExecOpts): Promise<ExecResult>;
  /**
   * Make `<agentHome>/.openhermit/skills/{system,user}/` reflect exactly the
   * given skill set inside the exec env: copies in, removes stale entries.
   * Each entry's `source` field decides the subdir.
   */
  syncSkills(skills: SyncSkillEntry[]): Promise<void>;
  /** Teardown (stop container, etc.). No-op if nothing to clean up. */
  shutdown(): Promise<void>;
  /** First-class filesystem ops. Path-policy enforcement happens at the
   * tool layer; the backend assumes the caller is authorised. */
  readonly files: import('./backends/file-backend.js').FileBackend;
}

// ── Config types ─────────────────────────────────────────────────────────

export interface DockerExecBackendConfig {
  id?: string;
  type: 'docker';
  label?: string;
  image: string;
  username?: string;
  agent_home?: string;
  memory_limit?: string;
  cpu_shares?: number;
  lifecycle?: WorkspaceContainerLifecycle;
}

export interface HostExecBackendConfig {
  id?: string;
  type: 'host';
  label?: string;
  cwd?: string;
  shell?: string;
  env?: Record<string, string>;
  timeout_ms?: number;
}

export interface E2BExecBackendConfig {
  id?: string;
  type: 'e2b';
  label?: string;
  template: string;
  username?: string;
  agent_home?: string;
  timeout_ms?: number;
  sandbox_timeout_ms?: number;
}

export interface DaytonaExecBackendConfig {
  id?: string;
  type: 'daytona';
  label?: string;
  snapshot?: string;
  image?: string;
  username?: string;
  agent_home?: string;
  timeout_ms?: number;
  auto_stop_interval_minutes?: number;
  env?: Record<string, string>;
  resources?: { cpu?: number; memory?: number };
}

export type ExecBackendConfig =
  | DockerExecBackendConfig
  | HostExecBackendConfig
  | E2BExecBackendConfig
  | DaytonaExecBackendConfig;

export interface ExecConfig {
  backends: ExecBackendConfig[];
  default_backend?: string;
  lifecycle?: WorkspaceContainerLifecycle;
}

// ── Backend factory registry ─────────────────────────────────────────────

export interface BackendFactoryContext {
  containerManager: DockerContainerManager;
  agentId: string;
  workspaceDir: string;
  /**
   * Live fetch of per-agent secrets flagged `passThrough: true`. Backends
   * call this on every exec to pick up additions/removals/edits without
   * recreating the sandbox. Returns env-var-name → value; should be cheap
   * (one DB roundtrip via SecretStore.listEntries).
   */
  passThroughEnvProvider?: () => Promise<Record<string, string>>;
  getRuntimeState?: () => Promise<Record<string, unknown> | null>;
  setRuntimeState?: (state: Record<string, unknown>) => Promise<void>;
  markActive?: (patch: {
    externalId?: string | null;
    lastSeenAt?: string;
  }) => Promise<void>;
}

type BackendFactory = (config: ExecBackendConfig, context: BackendFactoryContext) => ExecBackend;

const factories = new Map<string, BackendFactory>();

export const registerExecBackend = (type: string, factory: BackendFactory): void => {
  factories.set(type, factory);
};

export const createExecBackend = (config: ExecBackendConfig, context: BackendFactoryContext): ExecBackend => {
  const factory = factories.get(config.type);
  if (!factory) {
    throw new ValidationError(`Unknown exec backend type: ${config.type}`);
  }
  return factory(config, context);
};

// ── ExecBackendManager ───────────────────────────────────────────────────

export class ExecBackendManager {
  private readonly backends: Map<string, ExecBackend>;
  private readonly defaultId: string;

  constructor(backends: ExecBackend[], defaultId?: string) {
    this.backends = new Map(backends.map((b) => [b.id, b]));
    if (backends.length === 0) {
      throw new ValidationError('At least one exec backend must be configured.');
    }
    this.defaultId = defaultId ?? backends[0]!.id;
    if (!this.backends.has(this.defaultId)) {
      throw new ValidationError(`Default exec backend not found: ${this.defaultId}`);
    }
  }

  static fromConfig(
    execConfig: ExecConfig | undefined,
    context: BackendFactoryContext,
  ): ExecBackendManager {
    let configs: ExecBackendConfig[];
    let defaultId: string | undefined;

    if (execConfig && execConfig.backends.length > 0) {
      configs = execConfig.backends;
      defaultId = execConfig.default_backend;
    } else {
      configs = [{ type: 'host', id: 'host' }];
    }

    const usedIds = new Set<string>();
    for (const config of configs) {
      if (!config.id) {
        let candidate: string = config.type;
        let counter = 2;
        while (usedIds.has(candidate)) {
          candidate = `${config.type}-${counter++}`;
        }
        (config as { id?: string }).id = candidate;
      }
      usedIds.add(config.id!);
    }

    const backends = configs.map((c) => createExecBackend(c, context));
    return new ExecBackendManager(backends, defaultId);
  }

  static fromSandboxRows(
    rows: ReadonlyArray<{
      id: string;
      alias: string;
      type: string;
      config: Record<string, unknown>;
    }>,
    context: Omit<BackendFactoryContext, 'getRuntimeState' | 'setRuntimeState' | 'markActive'>,
    sandboxAccess: {
      getRuntimeState: (sandboxId: string) => Promise<Record<string, unknown> | null>;
      setRuntimeState: (sandboxId: string, state: Record<string, unknown>) => Promise<void>;
      markActive: (sandboxId: string, patch: {
        externalId?: string | null;
        lastSeenAt?: string;
      }) => Promise<void>;
    },
  ): ExecBackendManager {
    if (rows.length === 0) {
      throw new ValidationError('No sandboxes configured for this agent.');
    }
    const backends = rows.map((row) => {
      const ctx: BackendFactoryContext = {
        ...context,
        getRuntimeState: () => sandboxAccess.getRuntimeState(row.id),
        setRuntimeState: (state) => sandboxAccess.setRuntimeState(row.id, state),
        markActive: (patch) => sandboxAccess.markActive(row.id, patch),
      };
      const cfg = { ...row.config, type: row.type, id: row.alias } as ExecBackendConfig;
      return createExecBackend(cfg, ctx);
    });
    const defaultId = rows.find((r) => r.alias === 'default')?.alias ?? rows[0]!.alias;
    return new ExecBackendManager(backends, defaultId);
  }

  get(id?: string): ExecBackend {
    const targetId = id ?? this.defaultId;
    const backend = this.backends.get(targetId);
    if (!backend) {
      throw new NotFoundError(`Exec backend not found: ${targetId}`);
    }
    return backend;
  }

  getDefault(): ExecBackend {
    return this.get(this.defaultId);
  }

  list(): ExecBackend[] {
    return [...this.backends.values()];
  }

  async shutdownAll(): Promise<void> {
    await Promise.allSettled(
      [...this.backends.values()].map((b) => b.shutdown()),
    );
  }

  async syncSkills(skills: SyncSkillEntry[]): Promise<void> {
    for (const backend of this.backends.values()) {
      await backend.syncSkills(skills);
    }
  }
}
