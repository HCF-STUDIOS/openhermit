import { spawn } from 'node:child_process';
import path from 'node:path';

import { ValidationError } from '@openhermit/shared';

import { BoundedString, DEFAULT_EXEC_OUTPUT_MAX_BYTES } from '../bounded-string.js';
import type { ExecBackend, ExecOpts, ExecResult, SyncSkillEntry, BackendFactoryContext, HostExecBackendConfig } from '../exec-backend.js';
import { HostFileBackend, type FileBackend } from './file-backend.js';
import { registerExecBackend } from '../exec-backend.js';
import { syncSkillsToHostDir } from './shared.js';

const DEFAULT_TIMEOUT_MS = 300_000;

class HostExecBackend implements ExecBackend {
  readonly id: string;
  readonly type = 'host';
  readonly label: string;
  readonly username: string;
  readonly agentHome: string;
  readonly files: FileBackend;
  private readonly shell: string;
  private readonly env: Record<string, string> | undefined;
  private readonly timeoutMs: number;

  private readonly context: BackendFactoryContext;

  constructor(config: HostExecBackendConfig, context: BackendFactoryContext) {
    this.context = context;
    this.id = config.id ?? 'host';
    this.label = config.label ?? 'Host shell';
    this.username = process.env['USER'] ?? 'unknown';
    const home = process.env['HOME'];
    if (!home) {
      throw new ValidationError('HOME environment variable is not set; cannot use host exec backend.');
    }
    this.agentHome = config.cwd ?? home;
    this.shell = config.shell ?? 'sh';
    // Pass-through secrets are read fresh in exec() via the provider so
    // toggles take effect immediately. config.env (static, agent-defined)
    // still wins on key conflicts.
    this.env = config.env;
    this.timeoutMs = config.timeout_ms ?? DEFAULT_TIMEOUT_MS;
    this.files = new HostFileBackend(this.agentHome, this.agentHome);
  }

  async ensure(): Promise<void> {
    await this.context.markActive?.({
      lastSeenAt: new Date().toISOString(),
    });
  }

  async syncSkills(skills: SyncSkillEntry[]): Promise<void> {
    await syncSkillsToHostDir(
      path.join(this.agentHome, '.openhermit', 'skills'),
      skills,
    );
  }

  async exec(command: string, opts?: ExecOpts): Promise<ExecResult> {
    const startedAt = Date.now();
    const cwd = opts?.cwd ?? this.agentHome;

    const passEnv = (await this.context.passThroughEnvProvider?.()) ?? {};

    return new Promise<ExecResult>((resolve, reject) => {
      const child = spawn(this.shell, ['-lc', command], {
        cwd,
        env: { ...process.env, ...passEnv, ...(this.env ?? {}) },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const stdoutBuf = new BoundedString(DEFAULT_EXEC_OUTPUT_MAX_BYTES, 'stdout');
      const stderrBuf = new BoundedString(DEFAULT_EXEC_OUTPUT_MAX_BYTES, 'stderr');
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, this.timeoutMs);

      child.stdout.on('data', (chunk: Buffer) => stdoutBuf.append(chunk.toString()));
      child.stderr.on('data', (chunk: Buffer) => stderrBuf.append(chunk.toString()));

      child.on('error', (error) => {
        clearTimeout(timer);
        reject(new Error(`Failed to execute host command: ${error.message}`));
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        if (timedOut) {
          stderrBuf.append(`\n[killed: command timed out after ${this.timeoutMs}ms]`);
        }
        resolve({
          stdout: stdoutBuf.finalize(),
          stderr: stderrBuf.finalize(),
          exitCode: timedOut ? 137 : (code ?? 1),
          durationMs: Date.now() - startedAt,
        });
      });
    });
  }

  async shutdown(): Promise<void> {
    // No-op: host shell has no resource to release.
  }
}

registerExecBackend('host', (config, context) =>
  new HostExecBackend(config as HostExecBackendConfig, context),
);
