import { readdir, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
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

const uploadDirToTenki = async (
  session: import('@tenkicloud/sandbox').Session,
  localDir: string,
  remoteDir: string,
): Promise<void> => {
  await session.mkdir(remoteDir);
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

export class TenkiExecBackend implements ExecBackend {
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
    client?: import('@tenkicloud/sandbox').TenkiSandbox,
  ) {
    this.id = config.id ?? 'tenki';
    this.label = config.label ?? 'Tenki';
    this.username = TENKI_DEFAULT_USERNAME;
    this.agentHome = config.agent_home ?? TENKI_DEFAULT_AGENT_HOME;
    this.cpuCores = config.cpu_cores ?? TENKI_DEFAULT_CPU_CORES;
    this.memoryMb = config.memory_mb ?? TENKI_DEFAULT_MEMORY_MB;
    this.diskSizeGb = config.disk_size_gb ?? TENKI_DEFAULT_DISK_GB;
    this.timeoutMs = config.timeout_ms ?? TENKI_DEFAULT_TIMEOUT_MS;
    this.baseUrl = config.base_url;
    this.client = client ?? null;

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
    if (this.session) {
      await this.readySession(this.session);
      return;
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
          await this.replayPendingSkillSync();
          return;
        } catch (error) {
          this.session = null;
          throw error;
        }
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
    this.session = session;
    try {
      await session.mkdir(this.agentHome);
      await this.saveState({
        sessionId: session.id,
        cwd: this.agentHome,
        updatedAt: new Date().toISOString(),
        state: 'active',
      });
      await this.context.markActive?.({ externalId: session.id, lastSeenAt: new Date().toISOString() });
      await this.replayPendingSkillSync();
    } catch (error) {
      this.session = null;
      await session.closeIfOpen().catch(() => undefined);
      throw error;
    }
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
      const passEnv = (await this.context.passThroughEnvProvider?.()) ?? {};
      const handle = this.session!.run(['sh', '-c', command], {
        cwd,
        ...(Object.keys(passEnv).length > 0 ? { env: passEnv } : {}),
      });
      const timeout = Symbol('timeout');
      let timer: ReturnType<typeof setTimeout> | undefined;
      const outcome = await Promise.race([
        Promise.resolve(handle),
        new Promise<typeof timeout>((resolve) => { timer = setTimeout(() => resolve(timeout), this.timeoutMs); }),
      ]);
      if (timer) clearTimeout(timer);
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
        await this.ensure();
        await this.applySkillSync(skills);
        return;
      }
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
    const skillsDir = `${this.agentHome}/.openhermit/skills`;
    const nonce = randomUUID();
    const stageDir = `${skillsDir}/.tenki-stage-${nonce}`;
    const backupDir = `${skillsDir}/.tenki-backup-${nonce}`;
    await this.session.mkdir(`${stageDir}/system`);
    await this.session.mkdir(`${stageDir}/user`);
    try {
      for (const skill of skills) {
        const baseDir = skill.source === 'user' ? `${stageDir}/user` : `${stageDir}/system`;
        await uploadDirToTenki(this.session, skill.sourcePath, `${baseDir}/${skill.id}`);
      }
      const result = await this.session.run([
        'sh', '-c',
        `set -eu
mkdir -p "$1" "$3"
[ ! -e "$1/system" ] || mv "$1/system" "$3/system"
[ ! -e "$1/user" ] || mv "$1/user" "$3/user"
rollback() {
  rm -rf "$1/system" "$1/user"
  [ ! -e "$3/system" ] || mv "$3/system" "$1/system"
  [ ! -e "$3/user" ] || mv "$3/user" "$1/user"
}
trap rollback EXIT
mv "$2/system" "$1/system"
mv "$2/user" "$1/user"
trap - EXIT
rm -rf "$2" "$3"`,
        '--', skillsDir, stageDir, backupDir,
      ]);
      if (result.exitCode !== 0) {
        throw new Error(`Tenki skill swap failed: ${new TextDecoder().decode(result.stderr)}`);
      }
    } catch (error) {
      await this.session.run(['rm', '-rf', stageDir]).then(() => undefined, () => undefined);
      throw error;
    }
  }

  private async replayPendingSkillSync(): Promise<void> {
    if (!this.context.getRuntimeState) return;
    const state = await this.context.getRuntimeState();
    const pending = state?.['tenki_pending_skills'] as TenkiPendingSkillSync | undefined;
    if (!pending) return;
    await this.applySkillSync(
      pending.skills.map((s) => ({ id: s.id, sourcePath: s.sourcePath, source: s.source ?? 'system' })),
    );
    await this.savePendingSkillSync(null);
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
