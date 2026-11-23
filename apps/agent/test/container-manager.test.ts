import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  OpenHermitError,
  NotFoundError,
  ValidationError,
} from '@openhermit/shared';

import {
  type DockerCommandResult,
  type DockerRunner,
  DockerContainerManager,
} from '../src/core/index.js';
import { createWorkspaceFixture } from './helpers.js';

class FakeDockerRunner implements DockerRunner {
  readonly calls: string[][] = [];

  constructor(private readonly results: DockerCommandResult[]) {}

  async run(args: string[]): Promise<DockerCommandResult> {
    this.calls.push(args);

    const nextResult = this.results.shift();

    if (!nextResult) {
      throw new Error(`Unexpected docker call: ${args.join(' ')}`);
    }

    return nextResult;
  }
}

const okResult = (
  overrides: Partial<DockerCommandResult> = {},
): DockerCommandResult => ({
  stdout: '',
  stderr: '',
  exitCode: 0,
  durationMs: 5,
  ...overrides,
});

test('ensureWorkspaceContainer creates a new container when none exists', async (t) => {
  const { workspace } = await createWorkspaceFixture(t);
  const runner = new FakeDockerRunner([
    // listLiveContainers (ps -a)
    okResult({ stdout: '' }),
    // docker run
    okResult({ stdout: 'container-abc\n' }),
  ]);
  const manager = new DockerContainerManager(workspace, { runner });

  const entry = await manager.ensureWorkspaceContainer('default', {
    image: 'ubuntu:24.04',
    mount_target: '/root',
    username: 'root',
  });

  assert.equal(entry.status, 'running');
  assert.equal(entry.type, 'workspace');
  assert.equal(entry.image, 'ubuntu:24.04');
  assert.equal(entry.runtime_container_id, 'container-abc');

  const runArgs = runner.calls[1]!;
  assert.equal(runArgs[0], 'run');
  assert.ok(runArgs.includes('ubuntu:24.04'));
  assert.ok(runArgs.includes('sleep'));
});

test('ensureWorkspaceContainer reuses running container', async (t) => {
  const { workspace } = await createWorkspaceFixture(t);
  const runner = new FakeDockerRunner([
    okResult({
      stdout: JSON.stringify({
        ID: 'live-123',
        Names: 'openhermit-default-workspace',
        Image: 'ubuntu:24.04',
        Status: 'Up 5 minutes',
      }),
    }),
  ]);
  const manager = new DockerContainerManager(workspace, { runner });

  const entry = await manager.ensureWorkspaceContainer('default', {
    image: 'ubuntu:24.04',
    mount_target: '/root',
    username: 'root',
  });

  assert.equal(entry.status, 'running');
  assert.equal(entry.runtime_container_id, 'live-123');
  assert.equal(runner.calls.length, 1);
});

test('ensureWorkspaceContainer restarts stopped container', async (t) => {
  const { workspace } = await createWorkspaceFixture(t);
  const runner = new FakeDockerRunner([
    okResult({
      stdout: JSON.stringify({
        ID: 'stopped-456',
        Names: 'openhermit-default-workspace',
        Image: 'ubuntu:24.04',
        Status: 'Exited (0) 5 minutes ago',
      }),
    }),
    // docker start
    okResult({}),
  ]);
  const manager = new DockerContainerManager(workspace, { runner });

  const entry = await manager.ensureWorkspaceContainer('default', {
    image: 'ubuntu:24.04',
    mount_target: '/root',
    username: 'root',
  });

  assert.equal(entry.status, 'running');
  assert.deepEqual(runner.calls[1], ['start', 'openhermit-default-workspace']);
});

test('stopWorkspaceContainer stops a running container', async (t) => {
  const { workspace } = await createWorkspaceFixture(t);
  const runner = new FakeDockerRunner([
    okResult({ stdout: '' }),
    okResult({ stdout: 'container-abc\n' }),
    okResult({}),
  ]);
  const manager = new DockerContainerManager(workspace, { runner });

  await manager.ensureWorkspaceContainer('default', { image: 'ubuntu:24.04', mount_target: '/root', username: 'root' });
  await manager.stopWorkspaceContainer('default');

  const stopCall = runner.calls[2]!;
  assert.deepEqual(stopCall, ['stop', 'openhermit-default-workspace']);
});

test('execInWorkspace throws when container not running', async (t) => {
  const { workspace } = await createWorkspaceFixture(t);
  // execInWorkspace re-probes `docker ps` before giving up; no live container.
  const runner = new FakeDockerRunner([okResult({ stdout: '' })]);
  const manager = new DockerContainerManager(workspace, { runner });

  await assert.rejects(
    () => manager.execInWorkspace('default', 'echo hello'),
    NotFoundError,
  );
});

test('ensureWorkspaceContainer surfaces docker failures', async (t) => {
  const { workspace } = await createWorkspaceFixture(t);
  const runner = new FakeDockerRunner([
    okResult({ stdout: '' }),
    okResult({ exitCode: 125, stderr: 'no space left on device' }),
  ]);
  const manager = new DockerContainerManager(workspace, { runner });

  await assert.rejects(
    () => manager.ensureWorkspaceContainer('default', { image: 'ubuntu:24.04', mount_target: '/root', username: 'root' }),
    (error: unknown) => {
      assert.ok(error instanceof OpenHermitError);
      assert.equal(error.code, 'docker_run_failed');
      return true;
    },
  );
});
