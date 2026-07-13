import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

import { OpenHermitError, NotFoundError, ValidationError } from '@openhermit/shared';

import { BoundedString, DEFAULT_EXEC_OUTPUT_MAX_BYTES } from './bounded-string.js';
import {
  type ContainerProcessResult,
  type ContainerRegistryEntry,
  type ContainerStatus,
  type ContainerType,
  type WorkspaceContainerConfig,
} from './types.js';
import { AgentWorkspace } from './workspace.js';

const OUTPUT_START = '---OPENHERMIT_OUTPUT_START---';
const OUTPUT_END = '---OPENHERMIT_OUTPUT_END---';

const parseStructuredOutput = (stdout: string): unknown => {
  const startIndex = stdout.indexOf(OUTPUT_START);
  const endIndex = stdout.indexOf(OUTPUT_END);

  if (startIndex === -1 || endIndex === -1 || endIndex <= startIndex) {
    return undefined;
  }

  const jsonPayload = stdout
    .slice(startIndex + OUTPUT_START.length, endIndex)
    .trim();

  if (!jsonPayload) {
    return undefined;
  }

  try {
    return JSON.parse(jsonPayload);
  } catch {
    return jsonPayload;
  }
};

const deriveContainerStatus = (statusText: string | undefined): ContainerStatus => {
  if (!statusText) return 'unknown';
  if (statusText.startsWith('Up ')) return 'running';
  if (statusText.startsWith('Exited')) return 'exited';
  if (statusText.startsWith('Created')) return 'created';
  if (statusText.startsWith('Removed')) return 'removed';
  return 'unknown';
};

export interface DockerCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}

export interface DockerRunner {
  run(args: string[], timeoutMs?: number): Promise<DockerCommandResult>;
}

class DockerCliRunner implements DockerRunner {
  constructor(
    private readonly binary =
      process.env.OPENHERMIT_DOCKER_BIN ??
      'docker',
  ) {}

  async run(args: string[], timeoutMs?: number): Promise<DockerCommandResult> {
    const startedAt = Date.now();

    return new Promise<DockerCommandResult>((resolve, reject) => {
      const child = spawn(this.binary, args, {
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const stdoutBuf = new BoundedString(DEFAULT_EXEC_OUTPUT_MAX_BYTES, 'stdout');
      const stderrBuf = new BoundedString(DEFAULT_EXEC_OUTPUT_MAX_BYTES, 'stderr');
      let timedOut = false;

      const timer = timeoutMs
        ? setTimeout(() => {
            timedOut = true;
            child.kill('SIGKILL');
          }, timeoutMs)
        : undefined;

      child.stdout.on('data', (chunk) => stdoutBuf.append(chunk.toString()));
      child.stderr.on('data', (chunk) => stderrBuf.append(chunk.toString()));

      child.on('error', (error) => {
        if (timer) clearTimeout(timer);
        reject(
          new OpenHermitError(
            `Failed to execute docker command: ${error.message}`,
            'docker_unavailable',
            500,
          ),
        );
      });

      child.on('close', (code) => {
        if (timer) clearTimeout(timer);
        if (timedOut) {
          stderrBuf.append(`\n[killed: command timed out after ${timeoutMs}ms]`);
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
}

export interface DockerContainerManagerOptions {
  agentId?: string;
  runner?: DockerRunner;
}

export interface OpenHermitContainerInfo {
  id: string;
  name: string;
  agentId: string;
  type: ContainerType;
  image: string;
  status: ContainerStatus;
  statusText: string;
}

/**
 * List all docker containers managed by openhermit (name-prefixed
 * `openhermit-`) on the current host. Returns parsed agentId/type
 * extracted from the container's name pattern
 * `openhermit-{agentId}-{suffix}`.
 */
export const listAllOpenHermitContainers = async (
  runner: DockerRunner = new DockerCliRunner(),
): Promise<OpenHermitContainerInfo[]> => {
  const result = await runner.run(['ps', '-a', '--format', '{{json .}}']);
  if (result.exitCode !== 0) {
    throw new OpenHermitError(
      `Failed to list containers: ${result.stderr || result.stdout}`,
      'docker_ps_failed',
      500,
    );
  }

  const containers: OpenHermitContainerInfo[] = [];
  for (const line of result.stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let raw: Record<string, string>;
    try {
      raw = JSON.parse(trimmed) as Record<string, string>;
    } catch {
      continue;
    }
    // `Names` may include several comma-separated names; the canonical
    // openhermit one is the prefixed one.
    const name = (raw.Names ?? '')
      .split(',')
      .map((n) => n.trim())
      .find((n) => n.startsWith('openhermit-'));
    if (!name) continue;

    // openhermit-{agentId}-{suffix} — agentId may itself contain dashes,
    // so split off the trailing suffix. Only include containers whose
    // suffix matches a known openhermit container type so unrelated
    // containers (e.g. compose-managed postgres) are not surfaced.
    const stripped = name.slice('openhermit-'.length);
    const lastDash = stripped.lastIndexOf('-');
    if (lastDash === -1) continue;
    const agentId = stripped.slice(0, lastDash);
    const suffix = stripped.slice(lastDash + 1);
    if (suffix !== 'workspace') continue;
    const type: ContainerType = 'workspace';

    containers.push({
      id: raw.ID ?? '',
      name,
      agentId,
      type,
      image: raw.Image ?? '',
      status: deriveContainerStatus(raw.Status),
      statusText: raw.Status ?? '',
    });
  }
  return containers;
};

interface LiveDockerContainer {
  id: string;
  names: string;
  image: string;
  statusText: string;
}

export class DockerContainerManager {
  private readonly docker: DockerRunner;
  private readonly agentId: string;
  private workspaceEntry: ContainerRegistryEntry | undefined;

  constructor(
    private readonly workspace: AgentWorkspace,
    options: DockerContainerManagerOptions = {},
  ) {
    this.docker = options.runner ?? new DockerCliRunner();
    this.agentId = options.agentId ?? 'default';
  }

  private async listLiveContainers(): Promise<LiveDockerContainer[]> {
    const result = await this.docker.run(['ps', '-a', '--format', '{{json .}}']);

    if (result.exitCode !== 0) {
      throw new OpenHermitError(
        `Failed to inspect docker containers: ${result.stderr || result.stdout}`,
        'docker_ps_failed',
        500,
      );
    }

    return result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, string>)
      .map((container) => ({
        id: container.ID ?? '',
        names: container.Names ?? '',
        image: container.Image ?? '',
        statusText: container.Status ?? '',
      }));
  }

  private containerName(suffix: string): string {
    return `openhermit-${this.agentId}-${suffix}`;
  }

  async ensureWorkspaceContainer(
    agentId: string,
    config: WorkspaceContainerConfig,
  ): Promise<ContainerRegistryEntry> {
    const name = this.containerName('workspace');
    const mountTarget = config.mount_target;

    const liveContainers = await this.listLiveContainers();
    const live = liveContainers.find((c) => c.names === name);
    const liveStatus = live ? deriveContainerStatus(live.statusText) : undefined;

    if (liveStatus === 'running') {
      this.workspaceEntry = {
        ...(this.workspaceEntry ?? {
          id: live!.id,
          name,
          image: config.image,
          type: 'workspace' as const,
          mount: '.',
          mount_target: mountTarget,
          created: new Date().toISOString(),
        }),
        status: 'running',
        runtime_container_id: live!.id,
      };
      return this.workspaceEntry;
    }

    if (liveStatus === 'exited' || (this.workspaceEntry?.status === 'stopped' && liveStatus)) {
      const startResult = await this.docker.run(['start', name]);
      if (startResult.exitCode === 0) {
        // After gateway restart `this.workspaceEntry` is undefined; rebuild
        // from the docker-side info we just looked up so the returned entry
        // always carries the runtime container id (used as external_id).
        this.workspaceEntry = {
          id: this.workspaceEntry?.id ?? live!.id,
          name,
          image: this.workspaceEntry?.image ?? config.image,
          type: 'workspace',
          mount: this.workspaceEntry?.mount ?? '.',
          mount_target: this.workspaceEntry?.mount_target ?? mountTarget,
          created: this.workspaceEntry?.created ?? new Date().toISOString(),
          ...this.workspaceEntry,
          status: 'running',
          runtime_container_id: live!.id,
        };
        return this.workspaceEntry;
      }
    }

    // Remove stale container if it exists in an unrecoverable state.
    if (liveStatus) {
      await this.docker.run(['rm', '-f', name]);
    }

    const workspaceRoot = this.workspace.root;
    const dockerArgs = [
      'run', '-d',
      '--name', name,
      '-v', `${workspaceRoot}:${mountTarget}`,
      '-w', mountTarget,
    ];

    if (config.memory_limit) {
      dockerArgs.push('--memory', config.memory_limit);
    }
    if (config.cpu_shares) {
      dockerArgs.push('--cpu-shares', String(config.cpu_shares));
    }
    if (config.username && config.username !== 'root') {
      dockerArgs.push('--user', config.username);
    }

    dockerArgs.push(config.image, 'sleep', 'infinity');

    const result = await this.docker.run(dockerArgs);

    if (result.exitCode !== 0) {
      throw new OpenHermitError(
        `Failed to start workspace container: ${result.stderr || result.stdout}`,
        'docker_run_failed',
        500,
      );
    }

    const runtimeContainerId = result.stdout.trim();
    this.workspaceEntry = {
      id: this.workspaceEntry?.id ?? randomUUID(),
      name,
      image: config.image,
      type: 'workspace',
      status: 'running',
      mount: '.',
      mount_target: mountTarget,
      ...(runtimeContainerId ? { runtime_container_id: runtimeContainerId } : {}),
      created: this.workspaceEntry?.created ?? new Date().toISOString(),
    };

    return this.workspaceEntry;
  }

  async stopWorkspaceContainer(agentId: string): Promise<void> {
    const name = this.containerName('workspace');

    if (this.workspaceEntry && (this.workspaceEntry.status === 'stopped' || this.workspaceEntry.status === 'removed')) {
      return;
    }

    await this.docker.run(['stop', name]);
    if (this.workspaceEntry) {
      this.workspaceEntry = { ...this.workspaceEntry, status: 'stopped' };
    }
  }

  async execInWorkspace(
    agentId: string,
    command: string,
    cwd?: string,
    env?: Record<string, string>,
  ): Promise<ContainerProcessResult> {
    const name = this.containerName('workspace');

    if (!this.workspaceEntry || this.workspaceEntry.type !== 'workspace' || this.workspaceEntry.status !== 'running') {
      // Re-probe Docker in case ensure() was not called or state drifted
      const liveContainers = await this.listLiveContainers();
      const live = liveContainers.find((c) => c.names === name);
      if (live && live.statusText.startsWith('Up ')) {
        this.workspaceEntry = {
          ...(this.workspaceEntry ?? {
            id: live.id,
            name,
            image: 'unknown',
            type: 'workspace' as const,
            mount: '.',
            created: new Date().toISOString(),
          }),
          status: 'running',
          runtime_container_id: live.id,
        };
      } else {
        throw new NotFoundError(`Workspace container not found: ${name}`);
      }
    }

    const envArgs = Object.entries(env ?? {}).flatMap(([key, value]) => ['--env', `${key}=${value}`]);
    const execArgs = cwd
      ? ['exec', ...envArgs, '-w', cwd, name, 'sh', '-lc', command]
      : ['exec', ...envArgs, name, 'sh', '-lc', command];
    const result = await this.docker.run(execArgs, 300_000);
    const parsedOutput = parseStructuredOutput(result.stdout);

    return {
      ...result,
      ...(parsedOutput !== undefined ? { parsedOutput } : {}),
    };
  }
}
