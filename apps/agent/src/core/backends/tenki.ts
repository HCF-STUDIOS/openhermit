import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { ValidationError } from '@openhermit/shared';

import type { ExecBackend, ExecOpts, ExecResult, SyncSkillEntry, BackendFactoryContext, TenkiExecBackendConfig } from '../exec-backend.js';
import { TenkiFileBackend } from './file-backend.js';
import { registerExecBackend } from '../exec-backend.js';

const TENKI_DEFAULT_USERNAME = 'tenki';
const TENKI_DEFAULT_AGENT_HOME = '/home/tenki';
const TENKI_DEFAULT_TIMEOUT_MS = 300_000;
const TENKI_DEFAULT_CREATE_TIMEOUT_MS = 180_000;
const TENKI_DEFAULT_CPU_CORES = 2;
const TENKI_DEFAULT_MEMORY_MB = 4096;
const TENKI_DEFAULT_DISK_GB = 10;

/** Single-quote a value for safe interpolation into a `sh -c` string. */
const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

const uploadDirToTenki = async (
  session: import('@tenkicloud/sandbox').Session,
  localDir: string,
  remoteDir: string,
): Promise<void> => {
  const { mkdir: tenkiMkdir } = await import('@tenkicloud/sandbox');
  await tenkiMkdir(session, remoteDir);
  const entries = await readdir(localDir, { withFileTypes: true });
  for (const entry of entries) {
    const localPath = path.join(localDir, entry.name);
    const remotePath = `${remoteDir}/${entry.name}`;
    if (entry.isDirectory()) {
      await uploadDirToTenki(session, localPath, remotePath);
    } else if (entry.isFile()) {
      await session.writeFile(remotePath, await readFile(localPath));
    }
  }
};

interface TenkiBackendPersisted {
  sessionId: string;
  cwd: string;
  updatedAt: string;
  state?: 'active' | 'paused';
}

interface TenkiPendingSkillSync {
  skills: Array<{ id: string; sourcePath: string; source: 'system' | 'user' }>;
  queuedAt: string;
}

class TenkiExecBackend implements ExecBackend {
  readonly id: string;
  readonly type = 'tenki';
  readonly label: string;
  readonly username: string;
  readonly agentHome: string;
  readonly files: TenkiFileBackend;

  private readonly cpuCores: number;
  private readonly memoryMb: number;
  private readonly diskSizeGb: number;
  private readonly timeoutMs: number;
  private readonly baseUrl: string | undefined;
  private client: import('@tenkicloud/sandbox').TenkiSandbox | null = null;
  private session: import('@tenkicloud/sandbox').Session | null = null;

  constructor(
    config: TenkiExecBackendConfig,
    private readonly context: BackendFactoryContext,
  ) {
    this.id = config.id ?? 'tenki';
    this.label = config.label ?? 'Tenki';
    this.username = config.username ?? TENKI_DEFAULT_USERNAME;
    this.agentHome = config.agent_home ?? TENKI_DEFAULT_AGENT_HOME;
    this.cpuCores = config.cpu_cores ?? TENKI_DEFAULT_CPU_CORES;
    this.memoryMb = config.memory_mb ?? TENKI_DEFAULT_MEMORY_MB;
    this.diskSizeGb = config.disk_size_gb ?? TENKI_DEFAULT_DISK_GB;
    this.timeoutMs = config.timeout_ms ?? TENKI_DEFAULT_TIMEOUT_MS;
    this.baseUrl = config.base_url;

    this.files = new TenkiFileBackend();
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
    if (this.session) return;
    const client = await this.getClient();

    const persisted = await this.loadState();
    if (persisted?.sessionId) {
      try {
        const session = await client.get(persisted.sessionId);
        // Reconnecting to a paused session transparently resumes it; resume()
        // is harmless on an already-active session.
        try {
          await session.resume();
        } catch {
          // Already active or nothing to resume.
        }
        this.session = session;
        await this.saveState({ ...persisted, updatedAt: new Date().toISOString(), state: 'active' });
        await this.context.markActive?.({ externalId: session.id, lastSeenAt: new Date().toISOString() });
        await this.replayPendingSkillSync();
        return;
      } catch {
        // Session is gone / expired. Fall through and create a fresh one.
      }
    }

    const session = await client.createAndWait({
      cpuCores: this.cpuCores,
      memoryMb: this.memoryMb,
      diskSizeGb: this.diskSizeGb,
      sticky: true,
      metadata: { agentId: this.context.agentId },
      timeoutMs: TENKI_DEFAULT_CREATE_TIMEOUT_MS,
    });
    await session.exec('mkdir', { args: ['-p', this.agentHome] });

    this.session = session;
    await this.saveState({
      sessionId: session.id,
      cwd: this.agentHome,
      updatedAt: new Date().toISOString(),
      state: 'active',
    });
    await this.context.markActive?.({ externalId: session.id, lastSeenAt: new Date().toISOString() });
    await this.replayPendingSkillSync();
  }

  async exec(command: string, opts?: ExecOpts): Promise<ExecResult> {
    if (!this.session) {
      await this.ensure();
    }

    const startedAt = Date.now();
    const cwd = opts?.cwd ?? this.agentHome;
    // Tenki's exec runs argv directly (execve-style), so wrap the caller's
    // shell command in `sh -c` and honour cwd via a leading `cd`.
    const script = `cd ${shellQuote(cwd)} && ${command}`;
    try {
      const passEnv = (await this.context.passThroughEnvProvider?.()) ?? {};
      const result = await this.session!.exec('sh', {
        args: ['-c', script],
        ...(Object.keys(passEnv).length > 0 ? { env: passEnv } : {}),
        timeoutMs: this.timeoutMs,
      });
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
    if (!this.session) return;
    const systemDir = `${this.agentHome}/.openhermit/skills/system`;
    const userDir = `${this.agentHome}/.openhermit/skills/user`;
    await this.session.exec('sh', {
      args: ['-c', `rm -rf ${shellQuote(systemDir)} ${shellQuote(userDir)} && mkdir -p ${shellQuote(systemDir)} ${shellQuote(userDir)}`],
    });
    for (const skill of skills) {
      const baseDir = skill.source === 'user' ? userDir : systemDir;
      await uploadDirToTenki(this.session, skill.sourcePath, `${baseDir}/${skill.id}`);
    }
  }

  private async replayPendingSkillSync(): Promise<void> {
    if (!this.context.getRuntimeState) return;
    const state = await this.context.getRuntimeState();
    const pending = state?.['tenki_pending_skills'] as TenkiPendingSkillSync | undefined;
    if (!pending || !pending.skills?.length) return;
    try {
      await this.applySkillSync(
        pending.skills.map((s) => ({ id: s.id, sourcePath: s.sourcePath, source: s.source ?? 'system' })),
      );
      await this.savePendingSkillSync(null);
    } catch (error) {
      console.warn(
        `[exec-backend][tenki][${this.id}] failed to replay pending skill sync: ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }
  }

  private async savePendingSkillSync(pending: TenkiPendingSkillSync | null): Promise<void> {
    if (!this.context.setRuntimeState || !this.context.getRuntimeState) return;
    const current = (await this.context.getRuntimeState()) ?? {};
    if (pending === null) {
      const { tenki_pending_skills: _drop, ...rest } = current;
      void _drop;
      await this.context.setRuntimeState(rest);
    } else {
      await this.context.setRuntimeState({ ...current, tenki_pending_skills: pending });
    }
  }

  async shutdown(): Promise<void> {
    if (!this.session) return;
    let paused = false;
    try {
      await this.session.pause();
      paused = true;
    } catch {
      // Already paused or gone.
    }
    this.session = null;
    if (paused) {
      const persisted = await this.loadState();
      if (persisted?.sessionId) {
        await this.saveState({ ...persisted, updatedAt: new Date().toISOString(), state: 'paused' });
      }
    }
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
