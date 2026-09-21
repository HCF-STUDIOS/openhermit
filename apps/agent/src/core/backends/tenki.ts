import { readdir, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { ValidationError } from '@openhermit/shared';

import type { ExecBackend, ExecOpts, ExecResult, SyncSkillEntry, BackendFactoryContext, TenkiExecBackendConfig } from '../exec-backend.js';
import { ensureTenkiDirectories, TenkiFileBackend, toTenkiFsPath } from './file-backend.js';
import {
  assertSkillSourcesReadable,
  buildSkillManifestReadScript,
  buildSkillSyncCommitScript,
  parseSkillManifest,
  planSkillSync,
  reconcileSystemSkillsOnEnsure,
  writePendingSkillFlag,
  type ManagedSkillIds,
} from './shared.js';

/** Pre-flag runtime-state key. Honored for one reconcile on migration so a
 *  sandbox paused with a queued sync across the deploy still syncs (see shared.ts). */
const TENKI_LEGACY_PENDING_SKILLS_KEY = 'tenki_pending_skills';
import { registerExecBackend } from '../exec-backend.js';

const TENKI_DEFAULT_USERNAME = 'tenki';
const TENKI_DEFAULT_AGENT_HOME = '/home/tenki';
const TENKI_DEFAULT_TIMEOUT_MS = 300_000;
const TENKI_DEFAULT_CREATE_TIMEOUT_MS = 180_000;
const TENKI_DEFAULT_CPU_CORES = 2;
const TENKI_DEFAULT_MEMORY_MB = 4096;
const TENKI_DEFAULT_DISK_GB = 10;

const uploadDirToTenki = async (
  session: import('@tenkicloud/sandbox').Session,
  localDir: string,
  remoteDir: string,
  agentHome: string,
): Promise<void> => {
  await ensureTenkiDirectories(session, [remoteDir]);
  const entries = await readdir(localDir, { withFileTypes: true });
  for (const entry of entries) {
    const localPath = path.join(localDir, entry.name);
    const remotePath = `${remoteDir}/${entry.name}`;
    if (entry.isDirectory()) {
      await uploadDirToTenki(session, localPath, remotePath, agentHome);
    } else if (entry.isFile()) {
      await session.writeFile(toTenkiFsPath(agentHome, remotePath), await readFile(localPath));
    }
  }
};

interface TenkiBackendPersisted {
  sessionId: string;
  cwd: string;
  updatedAt: string;
  state?: 'active' | 'paused';
}

export class TenkiExecBackend implements ExecBackend {
  readonly id: string;
  readonly type = 'tenki';
  readonly label: string;
  readonly username: string;
  readonly agentHome: string;
  readonly files: TenkiFileBackend;
  /** Runner-supplied hook fired after a real connect/create (see ExecBackend). */
  onEnsured: ((info: { fresh: boolean }) => Promise<void>) | null = null;

  private readonly cpuCores: number;
  private readonly workspaceId: string | undefined;
  private readonly memoryMb: number;
  private readonly diskSizeGb: number;
  private readonly timeoutMs: number;
  private readonly baseUrl: string | undefined;
  private client: import('@tenkicloud/sandbox').TenkiSandbox | null = null;
  private session: import('@tenkicloud/sandbox').Session | null = null;
  private ensureInFlight: Promise<'live' | 'resumed' | 'created'> | null = null;

  constructor(
    config: TenkiExecBackendConfig,
    private readonly context: BackendFactoryContext,
    client?: import('@tenkicloud/sandbox').TenkiSandbox,
  ) {
    this.id = config.id ?? 'tenki';
    this.label = config.label ?? 'Tenki';
    this.username = TENKI_DEFAULT_USERNAME;
    this.agentHome = config.agent_home ?? TENKI_DEFAULT_AGENT_HOME;
    this.workspaceId = config.workspace_id;
    this.cpuCores = config.cpu_cores ?? TENKI_DEFAULT_CPU_CORES;
    this.memoryMb = config.memory_mb ?? TENKI_DEFAULT_MEMORY_MB;
    this.diskSizeGb = config.disk_size_gb ?? TENKI_DEFAULT_DISK_GB;
    this.timeoutMs = config.timeout_ms ?? TENKI_DEFAULT_TIMEOUT_MS;
    this.baseUrl = config.base_url;
    this.client = client ?? null;

    this.files = new TenkiFileBackend(this.agentHome);
    this.files.getSession = () => this.session;
    this.files.ensureSession = () => this.ensure();
    this.files.invalidate = () => { this.session = null; };
  }

  private async getClient(): Promise<import('@tenkicloud/sandbox').TenkiSandbox> {
    if (this.client) return this.client;
    const apiKey = process.env['TENKI_API_KEY'] ?? process.env['TENKI_AUTH_TOKEN'];
    if (!apiKey) {
      throw new ValidationError(
        'TENKI_API_KEY environment variable is not set. Add it to ~/.openhermit/gateway/.env to use the tenki backend.',
      );
    }
    const { TenkiSandbox } = await import('@tenkicloud/sandbox');
    this.client = new TenkiSandbox({
      authToken: apiKey,
      ...(this.baseUrl ? { baseUrl: this.baseUrl } : {}),
    });
    return this.client;
  }

  async ensure(): Promise<void> {
    if (this.ensureInFlight) {
      await this.ensureInFlight;
      return;
    }
    const pending = this.ensureSession();
    this.ensureInFlight = pending;
    let outcome: 'live' | 'resumed' | 'created';
    try {
      outcome = await pending;
    } finally {
      if (this.ensureInFlight === pending) this.ensureInFlight = null;
    }
    // Fire the hook only after the in-flight guard is cleared, so the reconcile
    // it triggers can re-enter ensure() (a live session short-circuits) without
    // awaiting the very promise it is running under. 'live' means we already
    // had a handle this process — we fired when we first obtained it.
    if (outcome !== 'live') await this.fireEnsured(outcome === 'created');
  }

  /**
   * Invoke the runner's onEnsured hook after a real connect/create. Best-effort:
   * a failing skill reconcile must never break sandbox startup.
   */
  private async fireEnsured(fresh: boolean): Promise<void> {
    try {
      await this.onEnsured?.({ fresh });
    } catch {
      // swallow — user-skill scan/restore is best-effort.
    }
  }

  private async ensureSession(): Promise<'live' | 'resumed' | 'created'> {
    if (this.session) {
      await this.readySession(this.session);
      return 'live';
    }
    const client = await this.getClient();

    const persisted = await this.loadState();
    if (persisted?.sessionId) {
      let session: import('@tenkicloud/sandbox').Session | null = null;
      try {
        session = await client.get(persisted.sessionId);
      } catch (error) {
        const { SessionExpiredError, SessionNotFoundError, SessionTerminatedError } = await import('@tenkicloud/sandbox');
        if (!(error instanceof SessionExpiredError) &&
            !(error instanceof SessionNotFoundError) &&
            !(error instanceof SessionTerminatedError)) {
          throw error;
        }
      }
      if (session && session.state !== 'TERMINATED' && session.state !== 'USER_SHUTDOWN') {
        await this.readySession(session);
        this.session = session;
        try {
          await this.saveState({ ...persisted, updatedAt: new Date().toISOString(), state: 'active' });
          await this.context.markActive?.({ externalId: session.id, lastSeenAt: new Date().toISOString() });
          await this.reconcileSystemSkills(false);
          return 'resumed';
        } catch (error) {
          this.session = null;
          throw error;
        }
      }
    }

    const session = await client.createAndWait({
      ...(this.workspaceId ? { workspaceId: this.workspaceId } : {}),
      cpuCores: this.cpuCores,
      memoryMb: this.memoryMb,
      diskSizeGb: this.diskSizeGb,
      sticky: true,
      metadata: { agentId: this.context.agentId },
      timeoutMs: TENKI_DEFAULT_CREATE_TIMEOUT_MS,
    });
    this.session = session;
    try {
      await this.saveState({
        sessionId: session.id,
        cwd: this.agentHome,
        updatedAt: new Date().toISOString(),
        state: 'active',
      });
      await this.context.markActive?.({ externalId: session.id, lastSeenAt: new Date().toISOString() });
      await this.reconcileSystemSkills(true);
    } catch (error) {
      this.session = null;
      await session.closeIfOpen().catch(() => undefined);
      throw error;
    }
    return 'created';
  }

  private async readySession(session: import('@tenkicloud/sandbox').Session): Promise<void> {
    if (session.state === 'PAUSED') await session.resume();
    if (session.state !== 'RUNNING') await session.waitReady(TENKI_DEFAULT_CREATE_TIMEOUT_MS);
  }

  async exec(command: string, opts?: ExecOpts): Promise<ExecResult> {
    if (!this.session) {
      await this.ensure();
    }

    const startedAt = Date.now();
    const cwd = opts?.cwd ?? this.agentHome;
    try {
      const passEnv = {
        ...((await this.context.passThroughEnvProvider?.()) ?? {}),
        ...(opts?.env ?? {}),
      };
      const handle = this.session!.run(['sh', '-c', command], {
        cwd,
        ...(Object.keys(passEnv).length > 0 ? { env: passEnv } : {}),
      });
      const timeout = Symbol('timeout');
      let timer: ReturnType<typeof setTimeout> | undefined;
      let outcome: Awaited<typeof handle> | typeof timeout;
      try {
        outcome = await Promise.race([
          Promise.resolve(handle),
          new Promise<typeof timeout>((resolve) => { timer = setTimeout(() => resolve(timeout), this.timeoutMs); }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
      if (outcome === timeout) {
        await handle.kill().catch(() => undefined);
        return {
          stdout: '',
          stderr: `Command timed out after ${this.timeoutMs}ms`,
          exitCode: 137,
          durationMs: Date.now() - startedAt,
        };
      }
      const result = outcome;
      return {
        stdout: new TextDecoder().decode(result.stdout),
        stderr: new TextDecoder().decode(result.stderr),
        exitCode: result.exitCode,
        durationMs: Date.now() - startedAt,
      };
    } catch (error: unknown) {
      // Transport-level failure (session evicted, network). Drop the cached
      // handle so the next call re-`ensure()`s (reconnect or recreate).
      this.session = null;
      return {
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error),
        exitCode: 1,
        durationMs: Date.now() - startedAt,
      };
    }
  }

  async syncSkills(skills: SyncSkillEntry[]): Promise<void> {
    if (!this.session) {
      if (!this.context.setRuntimeState || !this.context.getRuntimeState) {
        // No runtime state to carry a dirty flag across restarts, so we cannot
        // defer: bring the session up now and sync the given set directly.
        await this.ensure();
        await this.applySkillSync(skills);
        return;
      }
      // Session is paused/cold: just mark the dirty flag. The desired skill set
      // is re-derived from the DB on the next ensure(), so no host path (long
      // gone by wake-up time) is frozen into runtime_state.
      await this.setPendingSkillFlag(true);
      return;
    }
    await this.applySkillSync(skills);
    await this.setPendingSkillFlag(false);
  }

  private async applySkillSync(skills: SyncSkillEntry[]): Promise<void> {
    if (!this.session) return;
    // Stage the uploads, then swap them in one skill at a time. Earlier this
    // replaced the whole `system`/`user` pair, which also deleted directories
    // openhermit never synced; the manifest names the ones it did sync, and
    // only those are pruned.
    const skillsRoot = `${this.agentHome}/.openhermit/skills`;
    const previous = await this.readSkillManifest(skillsRoot);
    const plan = planSkillSync(skills, previous);

    // Fail before staging if any source is unreadable (e.g. a blob restore that
    // half-failed) — the commit swap deletes the old copy, so refusing keeps the
    // last-good skills in place.
    await assertSkillSourcesReadable(plan.install);
    const nonce = randomUUID();
    const stageRoot = `${skillsRoot}/.tenki-stage-${nonce}`;
    await ensureTenkiDirectories(this.session, [`${stageRoot}/system`, `${stageRoot}/user`]);
    try {
      for (const skill of plan.install) {
        await uploadDirToTenki(
          this.session,
          skill.sourcePath,
          `${stageRoot}/${skill.source}/${skill.id}`,
          this.agentHome,
        );
      }
      const result = await this.session.run([
        'sh', '-c', buildSkillSyncCommitScript(skillsRoot, plan, stageRoot),
      ]);
      if (result.exitCode !== 0) {
        throw new Error(`Tenki skill swap failed: ${new TextDecoder().decode(result.stderr)}`);
      }
    } catch (error) {
      await this.session.run(['rm', '-rf', stageRoot]).then(() => undefined, () => undefined);
      throw error;
    }
  }

  private async readSkillManifest(skillsRoot: string): Promise<ManagedSkillIds> {
    if (!this.session) return parseSkillManifest(null);
    try {
      const result = await this.session.run([
        'sh', '-c', buildSkillManifestReadScript(skillsRoot),
      ]);
      if (result.exitCode !== 0) return parseSkillManifest(null);
      return parseSkillManifest(new TextDecoder().decode(result.stdout));
    } catch {
      // Unreadable manifest means "nothing is managed" — prune nothing.
      return parseSkillManifest(null);
    }
  }

  /** Re-derive enabled system skills from the DB and push them if this session
   *  is fresh or woke with the dirty flag set. Delegates to the shared helper. */
  private reconcileSystemSkills(fresh: boolean): Promise<void> {
    return reconcileSystemSkillsOnEnsure({
      fresh,
      label: `tenki:${this.id}`,
      legacyPendingKey: TENKI_LEGACY_PENDING_SKILLS_KEY,
      getRuntimeState: this.context.getRuntimeState,
      setRuntimeState: this.context.setRuntimeState,
      getEnabledSystemSkills: this.context.getEnabledSystemSkills,
      apply: (s) => this.applySkillSync(s),
    });
  }

  private setPendingSkillFlag(dirty: boolean): Promise<void> {
    return writePendingSkillFlag(
      {
        getRuntimeState: this.context.getRuntimeState,
        setRuntimeState: this.context.setRuntimeState,
      },
      dirty,
    );
  }

  async shutdown(): Promise<void> {
    if (!this.session) return;
    const session = this.session;
    if (session.state !== 'PAUSED') await session.pause();
    const persisted = await this.loadState();
    if (persisted?.sessionId) {
      await this.saveState({ ...persisted, updatedAt: new Date().toISOString(), state: 'paused' });
    }
    this.session = null;
  }

  private async loadState(): Promise<TenkiBackendPersisted | null> {
    if (!this.context.getRuntimeState) return null;
    const state = await this.context.getRuntimeState();
    return (state?.['tenki'] as TenkiBackendPersisted) ?? null;
  }

  private async saveState(persisted: TenkiBackendPersisted): Promise<void> {
    if (!this.context.setRuntimeState || !this.context.getRuntimeState) return;
    const current = (await this.context.getRuntimeState()) ?? {};
    await this.context.setRuntimeState({ ...current, tenki: persisted });
  }
}

registerExecBackend('tenki', (config, context) =>
  new TenkiExecBackend(config as TenkiExecBackendConfig, context),
);
