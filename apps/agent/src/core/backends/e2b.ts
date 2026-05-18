import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { ValidationError } from '@openhermit/shared';

import type { ExecBackend, ExecOpts, ExecResult, SyncSkillEntry, BackendFactoryContext, E2BExecBackendConfig } from '../exec-backend.js';
import { E2BFileBackend } from './file-backend.js';
import { registerExecBackend } from '../exec-backend.js';

const E2B_DEFAULT_USERNAME = 'user';
const E2B_DEFAULT_AGENT_HOME = '/home/user';
const E2B_DEFAULT_TIMEOUT_MS = 300_000;
const E2B_DEFAULT_SANDBOX_TIMEOUT_MS = 600_000;

const uploadDirToE2B = async (
  sandbox: import('e2b').Sandbox,
  localDir: string,
  remoteDir: string,
): Promise<void> => {
  const entries = await readdir(localDir, { withFileTypes: true });
  for (const entry of entries) {
    const localPath = path.join(localDir, entry.name);
    const remotePath = `${remoteDir}/${entry.name}`;
    if (entry.isDirectory()) {
      await sandbox.files.makeDir(remotePath);
      await uploadDirToE2B(sandbox, localPath, remotePath);
    } else if (entry.isFile()) {
      const data = await readFile(localPath);
      const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
      await sandbox.files.write(remotePath, buf);
    }
  }
};

interface E2BBackendPersisted {
  sandboxId: string;
  template: string;
  cwd: string;
  updatedAt: string;
  /** Last intent we recorded:
   *  - 'active' after a successful connect/create
   *  - 'paused' after our own shutdown()→pause()
   * Informational; `connect()` itself transparently resumes paused
   * sandboxes, so this is for observability rather than dispatch. */
  state?: 'active' | 'paused';
}

interface E2BPendingSkillSync {
  skills: Array<{ id: string; sourcePath: string; source: 'system' | 'user' }>;
  queuedAt: string;
}

class E2BExecBackend implements ExecBackend {
  readonly id: string;
  readonly type = 'e2b';
  readonly label: string;
  readonly username: string;
  readonly agentHome: string;
  readonly files: E2BFileBackend;
  private readonly template: string;
  private readonly timeoutMs: number;
  private readonly sandboxTimeoutMs: number;

  private sandbox: import('e2b').Sandbox | null = null;

  constructor(
    config: E2BExecBackendConfig,
    private readonly context: BackendFactoryContext,
  ) {
    this.id = config.id ?? 'e2b';
    this.label = config.label ?? `E2B (${config.template})`;
    this.template = config.template;
    this.timeoutMs = config.timeout_ms ?? E2B_DEFAULT_TIMEOUT_MS;
    this.sandboxTimeoutMs = config.sandbox_timeout_ms ?? E2B_DEFAULT_SANDBOX_TIMEOUT_MS;
    this.username = config.username ?? E2B_DEFAULT_USERNAME;
    this.agentHome = config.agent_home ?? E2B_DEFAULT_AGENT_HOME;
    this.files = new E2BFileBackend();
    this.files.getSandbox = () => this.sandbox;
    this.files.ensureSandbox = () => this.ensure();
    this.files.invalidate = () => { this.sandbox = null; };

    // Fire-and-forget: reconcile persisted state with the remote on
    // startup. Catches the case where the previous process crashed
    // before recording a deliberate pause (or the sandbox was paused
    // out-of-band), so our DB stays in sync with e2b.
    void this.reconcilePersistedState();
  }

  /**
   * Best-effort check that runtime_state's `state` matches what e2b
   * reports for the persisted sandboxId. Runs once at construction.
   * Skips silently on any error — `ensure()` is the source of truth
   * for liveness and will overwrite this on first use.
   */
  private async reconcilePersistedState(): Promise<void> {
    try {
      if (this.sandbox) return;
      const persisted = await this.loadState();
      if (!persisted?.sandboxId) return;
      const apiKey = process.env['E2B_API_KEY'];
      if (!apiKey) return;
      const { Sandbox, SandboxNotFoundError } = await import('e2b');
      let remoteState: 'active' | 'paused';
      try {
        const info = await Sandbox.getInfo(persisted.sandboxId, { apiKey });
        remoteState = info.state === 'paused' ? 'paused' : 'active';
      } catch (err) {
        if (err instanceof SandboxNotFoundError) {
          // Remote is gone entirely. Leave sandboxId in place — ensure()
          // will hit the same 404 and fall through to create, which is
          // the right behaviour. No state to record here.
          return;
        }
        throw err;
      }
      // Re-check we haven't raced with ensure() taking ownership.
      if (this.sandbox) return;
      const fresh = await this.loadState();
      if (!fresh || fresh.sandboxId !== persisted.sandboxId) return;
      if (fresh.state === remoteState) return;
      await this.saveState({
        ...fresh,
        state: remoteState,
        updatedAt: new Date().toISOString(),
      });
    } catch {
      // Fire-and-forget: never let reconcile errors bubble up.
    }
  }

  async ensure(): Promise<void> {
    if (this.sandbox) return;

    const { Sandbox, SandboxNotFoundError } = await import('e2b');
    const apiKey = process.env['E2B_API_KEY'];
    if (!apiKey) {
      throw new ValidationError(
        'E2B_API_KEY environment variable is not set. Add it to ~/.openhermit/gateway/.env to use the e2b backend.',
      );
    }

    const persisted = await this.loadState();
    if (persisted?.sandboxId) {
      try {
        // `connect()` POSTs to /sandboxes/{id}/connect, which transparently
        // resumes paused sandboxes. So `persisted.state === 'paused'` and
        // `'active'` take the same code path — the state field is recorded
        // for observability, not branching.
        this.sandbox = await Sandbox.connect(persisted.sandboxId, {
          apiKey,
          timeoutMs: this.sandboxTimeoutMs,
        });
        await this.saveState({
          ...persisted,
          updatedAt: new Date().toISOString(),
          state: 'active',
        });
        await this.context.markActive?.({
          externalId: this.sandbox.sandboxId,
          lastSeenAt: new Date().toISOString(),
        });
        await this.replayPendingSkillSync();
        return;
      } catch (err) {
        if (!(err instanceof SandboxNotFoundError)) throw err;
        // 404 on connect = paused snapshot also expired. Fall through.
      }
    }

    this.sandbox = await Sandbox.create(this.template, {
      apiKey,
      timeoutMs: this.sandboxTimeoutMs,
      metadata: { agentId: this.context.agentId },
    });

    await this.sandbox.commands.run(`mkdir -p ${this.agentHome}`);

    await this.saveState({
      sandboxId: this.sandbox.sandboxId,
      template: this.template,
      cwd: this.agentHome,
      updatedAt: new Date().toISOString(),
      state: 'active',
    });
    await this.context.markActive?.({
      externalId: this.sandbox.sandboxId,
      lastSeenAt: new Date().toISOString(),
    });

    await this.replayPendingSkillSync();
  }

  async exec(command: string, opts?: ExecOpts): Promise<ExecResult> {
    if (!this.sandbox) {
      await this.ensure();
    }

    const startedAt = Date.now();
    try {
      const passEnv = (await this.context.passThroughEnvProvider?.()) ?? {};
      const result = await this.sandbox!.commands.run(command, {
        cwd: opts?.cwd ?? this.agentHome,
        timeoutMs: this.timeoutMs,
        ...(Object.keys(passEnv).length > 0 ? { envs: passEnv } : {}),
      });
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        durationMs: Date.now() - startedAt,
      };
    } catch (error: unknown) {
      if (error && typeof error === 'object' && 'exitCode' in error && 'stdout' in error && 'stderr' in error) {
        const e = error as { exitCode: number; stdout: string; stderr: string };
        return {
          stdout: e.stdout,
          stderr: e.stderr,
          exitCode: e.exitCode,
          durationMs: Date.now() - startedAt,
        };
      }
      const { SandboxNotFoundError } = await import('e2b');
      if (error instanceof SandboxNotFoundError) {
        // Cached handle points at a dead/paused-and-evicted sandbox.
        // Drop it so the next call re-enters ensure() → connect (auto-
        // resume) or create. The current call still surfaces the error.
        this.sandbox = null;
      }
      return {
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error),
        exitCode: 1,
        durationMs: Date.now() - startedAt,
      };
    }
  }

  async syncSkills(skills: SyncSkillEntry[]): Promise<void> {
    if (!this.sandbox) {
      await this.savePendingSkillSync({
        skills: skills.map((s) => ({ id: s.id, sourcePath: s.sourcePath, source: s.source })),
        queuedAt: new Date().toISOString(),
      });
      return;
    }

    await this.applySkillSync(skills);
    await this.savePendingSkillSync(null);
  }

  private async applySkillSync(skills: SyncSkillEntry[]): Promise<void> {
    if (!this.sandbox) return;
    // Always reset both subdirs so uninstalling the last skill of a source
    // actually clears it remotely.
    const systemDir = `${this.agentHome}/.openhermit/skills/system`;
    const userDir = `${this.agentHome}/.openhermit/skills/user`;
    await this.sandbox.commands.run(
      `rm -rf ${systemDir} ${userDir} && mkdir -p ${systemDir} ${userDir}`,
    );
    for (const skill of skills) {
      const baseDir = skill.source === 'user' ? userDir : systemDir;
      const remoteSkillDir = `${baseDir}/${skill.id}`;
      await this.sandbox.files.makeDir(remoteSkillDir);
      await uploadDirToE2B(this.sandbox, skill.sourcePath, remoteSkillDir);
    }
  }

  private async replayPendingSkillSync(): Promise<void> {
    if (!this.context.getRuntimeState) return;
    const state = await this.context.getRuntimeState();
    const pending = state?.['e2b_pending_skills'] as E2BPendingSkillSync | undefined;
    if (!pending || !pending.skills?.length) return;
    try {
      await this.applySkillSync(
        pending.skills.map((s) => ({
          id: s.id,
          sourcePath: s.sourcePath,
          // Tolerate state saved before the source column existed.
          source: s.source ?? 'system',
        })),
      );
      await this.savePendingSkillSync(null);
    } catch (error) {
      console.warn(
        `[exec-backend][e2b][${this.id}] failed to replay pending skill sync: ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }
  }

  private async savePendingSkillSync(pending: E2BPendingSkillSync | null): Promise<void> {
    if (!this.context.setRuntimeState || !this.context.getRuntimeState) return;
    const current = (await this.context.getRuntimeState()) ?? {};
    if (pending === null) {
      const { e2b_pending_skills: _drop, ...rest } = current;
      void _drop;
      await this.context.setRuntimeState(rest);
    } else {
      await this.context.setRuntimeState({ ...current, e2b_pending_skills: pending });
    }
  }

  async shutdown(): Promise<void> {
    if (!this.sandbox) return;
    let paused = false;
    try {
      await this.sandbox.pause();
      paused = true;
    } catch {
      // Already paused or gone.
    }
    this.sandbox = null;
    if (paused) {
      const persisted = await this.loadState();
      if (persisted?.sandboxId) {
        await this.saveState({
          ...persisted,
          updatedAt: new Date().toISOString(),
          state: 'paused',
        });
      }
    }
  }

  private async loadState(): Promise<E2BBackendPersisted | null> {
    if (!this.context.getRuntimeState) return null;
    const state = await this.context.getRuntimeState();
    return (state?.['e2b'] as E2BBackendPersisted) ?? null;
  }

  private async saveState(persisted: E2BBackendPersisted): Promise<void> {
    if (!this.context.setRuntimeState || !this.context.getRuntimeState) return;
    const current = (await this.context.getRuntimeState()) ?? {};
    await this.context.setRuntimeState({ ...current, e2b: persisted });
  }
}

registerExecBackend('e2b', (config, context) =>
  new E2BExecBackend(config as E2BExecBackendConfig, context),
);
