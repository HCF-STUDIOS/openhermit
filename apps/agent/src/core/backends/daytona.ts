import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { ValidationError } from '@openhermit/shared';

import type { ExecBackend, ExecOpts, ExecResult, SyncSkillEntry, BackendFactoryContext, DaytonaExecBackendConfig } from '../exec-backend.js';
import { DaytonaFileBackend } from './file-backend.js';
import { registerExecBackend } from '../exec-backend.js';

const DAYTONA_DEFAULT_USERNAME = 'daytona';
const DAYTONA_DEFAULT_AGENT_HOME = '/home/daytona';
const DAYTONA_DEFAULT_TIMEOUT_MS = 300_000;
const DAYTONA_DEFAULT_AUTO_STOP_MINUTES = 15;

const uploadDirToDaytona = async (
  sandbox: import('@daytonaio/sdk').Sandbox,
  localDir: string,
  remoteDir: string,
): Promise<void> => {
  const files: { source: Buffer; destination: string }[] = [];
  const dirs: string[] = [];

  const walk = async (local: string, remote: string): Promise<void> => {
    const entries = await readdir(local, { withFileTypes: true });
    for (const entry of entries) {
      const localPath = path.join(local, entry.name);
      const remotePath = `${remote}/${entry.name}`;
      if (entry.isDirectory()) {
        dirs.push(remotePath);
        await walk(localPath, remotePath);
      } else if (entry.isFile()) {
        files.push({ source: await readFile(localPath), destination: remotePath });
      }
    }
  };
  await walk(localDir, remoteDir);

  for (const dir of dirs) {
    await sandbox.fs.createFolder(dir, '755');
  }
  if (files.length > 0) {
    await sandbox.fs.uploadFiles(files);
  }
};

interface DaytonaBackendPersisted {
  sandboxId: string;
  source: { snapshot?: string; image?: string };
  cwd: string;
  updatedAt: string;
}

interface DaytonaPendingSkillSync {
  skills: Array<{ id: string; sourcePath: string }>;
  queuedAt: string;
}

class DaytonaExecBackend implements ExecBackend {
  readonly id: string;
  readonly type = 'daytona';
  readonly label: string;
  readonly username: string;
  readonly agentHome: string;
  readonly files: DaytonaFileBackend;
  private readonly snapshot: string | undefined;
  private readonly image: string | undefined;
  private readonly timeoutMs: number;
  private readonly autoStopMinutes: number;
  private readonly envVars: Record<string, string> | undefined;
  private readonly resources: { cpu?: number; memory?: number } | undefined;

  private sandbox: import('@daytonaio/sdk').Sandbox | null = null;

  constructor(
    config: DaytonaExecBackendConfig,
    private readonly context: BackendFactoryContext,
  ) {
    this.id = config.id ?? 'daytona';
    this.label = config.label ?? `Daytona (${config.snapshot ?? config.image ?? 'default'})`;
    this.snapshot = config.snapshot;
    this.image = config.image;
    this.timeoutMs = config.timeout_ms ?? DAYTONA_DEFAULT_TIMEOUT_MS;
    this.autoStopMinutes = config.auto_stop_interval_minutes ?? DAYTONA_DEFAULT_AUTO_STOP_MINUTES;
    // Pass-through secrets are read fresh on every exec via the provider so
    // toggles take effect without recreating the sandbox. Only static,
    // agent-defined env is baked in at create time.
    this.envVars = config.env && Object.keys(config.env).length > 0 ? config.env : undefined;
    this.resources = config.resources;
    this.username = config.username ?? DAYTONA_DEFAULT_USERNAME;
    this.agentHome = config.agent_home ?? DAYTONA_DEFAULT_AGENT_HOME;
    this.files = new DaytonaFileBackend();
    this.files.ensureSandbox = () => this.ensure();
  }

  async ensure(): Promise<void> {
    if (this.sandbox) return;

    const { Daytona } = await import('@daytonaio/sdk');
    const apiKey = process.env['DAYTONA_API_KEY'];
    if (!apiKey) {
      throw new ValidationError(
        'DAYTONA_API_KEY environment variable is not set. Add it to ~/.openhermit/gateway/.env to use the daytona backend.',
      );
    }
    const daytona = new Daytona({ apiKey });

    const persisted = await this.loadState();
    if (persisted?.sandboxId) {
      try {
        const existing = await daytona.get(persisted.sandboxId);
        if (existing.state !== 'started') {
          await existing.start();
        }
        this.sandbox = existing;
        this.files.sandbox = existing;
        await this.context.markActive?.({
          externalId: existing.id,
          lastSeenAt: new Date().toISOString(),
        });
        await this.replayPendingSkillSync();
        return;
      } catch {
        // Sandbox gone — create a new one.
      }
    }

    const createParams: Record<string, unknown> = {
      autoStopInterval: this.autoStopMinutes,
      ...(this.snapshot ? { snapshot: this.snapshot } : {}),
      ...(this.image ? { image: this.image } : {}),
      ...(this.envVars ? { envVars: this.envVars } : {}),
      ...(this.resources ? { resources: this.resources } : {}),
    };
    this.sandbox = await daytona.create(
      createParams as Parameters<typeof daytona.create>[0],
    );
    this.files.sandbox = this.sandbox;

    await this.sandbox.process.executeCommand(`mkdir -p ${this.agentHome}`);

    await this.saveState({
      sandboxId: this.sandbox.id,
      source: {
        ...(this.snapshot ? { snapshot: this.snapshot } : {}),
        ...(this.image ? { image: this.image } : {}),
      },
      cwd: this.agentHome,
      updatedAt: new Date().toISOString(),
    });
    await this.context.markActive?.({
      externalId: this.sandbox.id,
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
      const timeoutSec = Math.max(1, Math.ceil(this.timeoutMs / 1000));
      const passEnv = (await this.context.passThroughEnvProvider?.()) ?? {};
      const response = await this.sandbox!.process.executeCommand(
        command,
        opts?.cwd ?? this.agentHome,
        Object.keys(passEnv).length > 0 ? passEnv : undefined,
        timeoutSec,
      );
      const output = response.result ?? '';
      const exitCode = response.exitCode ?? 0;
      return {
        stdout: exitCode === 0 ? output : '',
        stderr: exitCode === 0 ? '' : output,
        exitCode,
        durationMs: Date.now() - startedAt,
      };
    } catch (error: unknown) {
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
        skills: skills.map((s) => ({ id: s.id, sourcePath: s.sourcePath })),
        queuedAt: new Date().toISOString(),
      });
      return;
    }

    await this.applySkillSync(skills);
    await this.savePendingSkillSync(null);
  }

  private async applySkillSync(skills: SyncSkillEntry[]): Promise<void> {
    if (!this.sandbox) return;
    const remoteSystemDir = `${this.agentHome}/.openhermit/skills/system`;
    await this.sandbox.process.executeCommand(`rm -rf ${remoteSystemDir} && mkdir -p ${remoteSystemDir}`);
    for (const skill of skills) {
      const remoteSkillDir = `${remoteSystemDir}/${skill.id}`;
      await this.sandbox.fs.createFolder(remoteSkillDir, '755');
      await uploadDirToDaytona(this.sandbox, skill.sourcePath, remoteSkillDir);
    }
  }

  private async replayPendingSkillSync(): Promise<void> {
    if (!this.context.getRuntimeState) return;
    const state = await this.context.getRuntimeState();
    const pending = state?.['daytona_pending_skills'] as DaytonaPendingSkillSync | undefined;
    if (!pending || !pending.skills?.length) return;
    try {
      await this.applySkillSync(pending.skills.map((s) => ({ id: s.id, sourcePath: s.sourcePath })));
      await this.savePendingSkillSync(null);
    } catch (error) {
      console.warn(
        `[exec-backend][daytona][${this.id}] failed to replay pending skill sync: ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }
  }

  private async savePendingSkillSync(pending: DaytonaPendingSkillSync | null): Promise<void> {
    if (!this.context.setRuntimeState || !this.context.getRuntimeState) return;
    const current = (await this.context.getRuntimeState()) ?? {};
    if (pending === null) {
      const { daytona_pending_skills: _drop, ...rest } = current;
      void _drop;
      await this.context.setRuntimeState(rest);
    } else {
      await this.context.setRuntimeState({ ...current, daytona_pending_skills: pending });
    }
  }

  async shutdown(): Promise<void> {
    if (!this.sandbox) return;
    try {
      await this.sandbox.stop();
    } catch {
      // Already stopped or gone.
    }
    this.sandbox = null;
    this.files.sandbox = null;
  }

  private async loadState(): Promise<DaytonaBackendPersisted | null> {
    if (!this.context.getRuntimeState) return null;
    const state = await this.context.getRuntimeState();
    return (state?.['daytona'] as DaytonaBackendPersisted) ?? null;
  }

  private async saveState(persisted: DaytonaBackendPersisted): Promise<void> {
    if (!this.context.setRuntimeState || !this.context.getRuntimeState) return;
    const current = (await this.context.getRuntimeState()) ?? {};
    await this.context.setRuntimeState({ ...current, daytona: persisted });
  }
}

registerExecBackend('daytona', (config, context) =>
  new DaytonaExecBackend(config as DaytonaExecBackendConfig, context),
);
