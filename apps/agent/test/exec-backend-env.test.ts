import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  createExecBackend,
  DockerContainerManager,
  type BackendFactoryContext,
  type DockerCommandResult,
  type DockerRunner,
} from '../src/core/index.js';
import { createWorkspaceFixture } from './helpers.js';

const fakeContext: BackendFactoryContext = {
  containerManager: {} as DockerContainerManager,
  agentId: 'test-agent',
  workspaceDir: '/tmp/workspace',
};

// ── host backend: env reaches the spawned process ─────────────────────────

const restoreEnv = (key: string, prev: string | undefined): void => {
  if (prev === undefined) delete process.env[key];
  else process.env[key] = prev;
};

test('host backend: ExecOpts.env is visible to the spawned command', async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'oh-env-host-'));
  const prevHome = process.env['HOME'];
  const prevMyTestVar = process.env['MY_TEST_VAR'];
  try {
    process.env['HOME'] = tmp;
    delete process.env['MY_TEST_VAR'];
    const backend = createExecBackend({ type: 'host' }, fakeContext);
    const result = await backend.exec(`printf '%s' "$MY_TEST_VAR"`, {
      env: { MY_TEST_VAR: 'hello-from-opts' },
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, 'hello-from-opts');
  } finally {
    restoreEnv('HOME', prevHome);
    restoreEnv('MY_TEST_VAR', prevMyTestVar);
    await rm(tmp, { recursive: true, force: true });
  }
});

test('host backend: absent env means the var is unset in the process', async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'oh-env-host-'));
  const prevHome = process.env['HOME'];
  const prevMyTestVar = process.env['MY_TEST_VAR'];
  try {
    process.env['HOME'] = tmp;
    delete process.env['MY_TEST_VAR'];
    const backend = createExecBackend({ type: 'host' }, fakeContext);
    const result = await backend.exec(`printf '%s' "${'$'}{MY_TEST_VAR:-<unset>}"`);
    assert.equal(result.stdout, '<unset>');
  } finally {
    restoreEnv('HOME', prevHome);
    restoreEnv('MY_TEST_VAR', prevMyTestVar);
    await rm(tmp, { recursive: true, force: true });
  }
});

// ── docker backend: env plumbs into the docker exec argv ──────────────────

class FakeDockerRunner implements DockerRunner {
  readonly calls: string[][] = [];
  constructor(private readonly results: DockerCommandResult[]) {}
  async run(args: string[]): Promise<DockerCommandResult> {
    this.calls.push(args);
    const next = this.results.shift();
    if (!next) throw new Error(`Unexpected docker call: ${args.join(' ')}`);
    return next;
  }
}

const okResult = (o: Partial<DockerCommandResult> = {}): DockerCommandResult => ({
  stdout: '',
  stderr: '',
  exitCode: 0,
  durationMs: 1,
  ...o,
});

test('container-manager: execInWorkspace threads env into --env argv flags', async (t) => {
  const { workspace } = await createWorkspaceFixture(t);
  const runner = new FakeDockerRunner([
    // listLiveContainers re-probe: report the workspace container as Up.
    okResult({
      stdout: JSON.stringify({
        ID: 'live-1',
        Names: 'openhermit-default-workspace',
        Image: 'ubuntu:24.04',
        Status: 'Up 2 minutes',
      }),
    }),
    // the exec itself
    okResult({ stdout: 'done' }),
  ]);
  const manager = new DockerContainerManager(workspace, { runner });

  await manager.execInWorkspace('default', 'run-it', '/root/work', {
    OPENHERMIT_SESSION_ID: 'sess-1',
    OPENHERMIT_AGENT_ID: 'agent-1',
  });

  const execCall = runner.calls[1]!;
  assert.equal(execCall[0], 'exec');
  // Each env var becomes an adjacent `--env KEY=VALUE` pair.
  const sessIdx = execCall.indexOf('OPENHERMIT_SESSION_ID=sess-1');
  const agentIdx = execCall.indexOf('OPENHERMIT_AGENT_ID=agent-1');
  assert.ok(sessIdx > 0 && execCall[sessIdx - 1] === '--env');
  assert.ok(agentIdx > 0 && execCall[agentIdx - 1] === '--env');
  // cwd and command are still present.
  assert.ok(execCall.includes('-w'));
  assert.ok(execCall.includes('/root/work'));
  assert.ok(execCall.includes('run-it'));
});

test('container-manager: no env means no --env flags in the argv', async (t) => {
  const { workspace } = await createWorkspaceFixture(t);
  const runner = new FakeDockerRunner([
    okResult({
      stdout: JSON.stringify({
        ID: 'live-2',
        Names: 'openhermit-default-workspace',
        Image: 'ubuntu:24.04',
        Status: 'Up 2 minutes',
      }),
    }),
    okResult({ stdout: 'done' }),
  ]);
  const manager = new DockerContainerManager(workspace, { runner });

  await manager.execInWorkspace('default', 'run-it');

  const execCall = runner.calls[1]!;
  assert.ok(!execCall.includes('--env'), `expected no --env flags, got: ${execCall.join(' ')}`);
});

// ── e2b backend: env is merged into the sandbox run options ────────────────

interface RunOptions {
  cwd?: string;
  timeoutMs?: number;
  envs?: Record<string, string>;
}

interface RunCapture {
  command?: string;
  options?: RunOptions;
}

function e2bBackendWithFakeSandbox(
  capture: RunCapture,
  over: Partial<BackendFactoryContext> = {},
) {
  const ctx: BackendFactoryContext = { ...fakeContext, ...over };
  const backend = createExecBackend({ type: 'e2b', template: 'tpl' }, ctx);
  // Inject a live sandbox so exec() skips ensure() and never touches the real
  // e2b SDK; commands.run captures whatever the backend forwards.
  (backend as unknown as { sandbox: unknown }).sandbox = {
    sandboxId: 'sbx-fake',
    commands: {
      run: async (command: string, options: RunOptions) => {
        capture.command = command;
        capture.options = options;
        return { stdout: 'ok', stderr: '', exitCode: 0 };
      },
    },
  };
  return backend;
}

test('e2b backend: ExecOpts.env is forwarded as sandbox run envs', async () => {
  const cap: RunCapture = {};
  const backend = e2bBackendWithFakeSandbox(cap);
  await backend.exec('do-thing', { env: { OPENHERMIT_SESSION_ID: 'sess-e2b' } });
  assert.deepEqual(cap.options?.envs, { OPENHERMIT_SESSION_ID: 'sess-e2b' });
});

test('e2b backend: passthrough secrets merge with opts.env, opts wins on conflict', async () => {
  const cap: RunCapture = {};
  const backend = e2bBackendWithFakeSandbox(cap, {
    passThroughEnvProvider: async () => ({ SHARED: 'from-secret', SECRET_ONLY: 's' }),
  });
  await backend.exec('do-thing', { env: { SHARED: 'from-opts', OPT_ONLY: 'o' } });
  assert.deepEqual(cap.options?.envs, {
    SHARED: 'from-opts',
    SECRET_ONLY: 's',
    OPT_ONLY: 'o',
  });
});

test('e2b backend: no env and no passthrough means envs is omitted', async () => {
  const cap: RunCapture = {};
  const backend = e2bBackendWithFakeSandbox(cap);
  await backend.exec('do-thing');
  assert.equal(cap.options?.envs, undefined);
});
