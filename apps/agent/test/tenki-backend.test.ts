import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ValidationError } from '@openhermit/shared';
import { FileNotFoundError, UnauthorizedError } from '@tenkicloud/sandbox';

import { TenkiExecBackend } from '../src/core/backends/tenki.js';
import { TenkiFileBackend, toTenkiFsPath } from '../src/core/backends/file-backend.js';

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);

const processHandle = (
  result: Promise<{ exitCode: number; stdout: Uint8Array; stderr: Uint8Array }>,
  kill: () => Promise<void> = async () => undefined,
) => Object.assign(result, { kill });

const context = {
  agentId: 'agent-test',
  workspaceDir: '/tmp/agent-test',
  containerManager: {} as never,
};

test('Tenki filesystem paths translate from absolute agent paths to SDK-relative paths', () => {
  assert.equal(toTenkiFsPath('/home/tenki', '/home/tenki/work/probe.txt'), 'work/probe.txt');
  assert.equal(toTenkiFsPath('/home/tenki', '/home/tenki'), '.');
  assert.throws(() => toTenkiFsPath('/home/tenki', '/tmp/probe.txt'), ValidationError);
});

test('Tenki exec preserves normal non-zero command results', async () => {
  let createOptions: Record<string, unknown> | undefined;
  const session = {
    id: 'session-1', state: 'RUNNING', mkdir: async () => undefined,
    run: () => processHandle(Promise.resolve({ exitCode: 42, stdout: bytes('out'), stderr: bytes('err') })),
    closeIfOpen: async () => undefined,
  };
  const client = { createAndWait: async (options: Record<string, unknown>) => {
    createOptions = options;
    return session;
  } };
  const backend = new TenkiExecBackend(
    { type: 'tenki', project_id: 'project-test' }, context as never, client as never,
  );

  const result = await backend.exec('exit 42');
  assert.equal(result.stdout, 'out');
  assert.equal(result.stderr, 'err');
  assert.equal(result.exitCode, 42);
  assert.ok(result.durationMs >= 0);
  assert.equal(createOptions?.projectId, 'project-test');
});

test('Tenki exec kills timed-out process and returns 137', async () => {
  let killed = false;
  const session = {
    id: 'session-1', state: 'RUNNING', mkdir: async () => undefined,
    run: () => processHandle(new Promise(() => undefined), async () => { killed = true; }),
    closeIfOpen: async () => undefined,
  };
  const backend = new TenkiExecBackend(
    { type: 'tenki', project_id: 'project-test', timeout_ms: 1 }, context as never,
    { createAndWait: async () => session } as never,
  );

  const result = await backend.exec('sleep 10');
  assert.equal(result.exitCode, 137);
  assert.equal(killed, true);
});

test('Tenki ensure serializes concurrent sandbox creation', async () => {
  let creates = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const session = {
    id: 'session-1', state: 'RUNNING', closeIfOpen: async () => undefined,
  };
  const backend = new TenkiExecBackend(
    { type: 'tenki', project_id: 'project-test' }, context as never,
    { createAndWait: async () => { creates += 1; await gate; return session; } } as never,
  );

  const first = backend.ensure();
  const second = backend.ensure();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(creates, 1);
  release();
  await Promise.all([first, second]);
});

test('Tenki exec clears timeout when process handle rejects', async () => {
  let cleared = 0;
  const originalClearTimeout = globalThis.clearTimeout;
  const session = {
    id: 'session-1', state: 'RUNNING', closeIfOpen: async () => undefined,
    run: () => processHandle(Promise.reject(new Error('transport'))),
  };
  const backend = new TenkiExecBackend(
    { type: 'tenki', project_id: 'project-test', timeout_ms: 60_000 }, context as never,
    { createAndWait: async () => session } as never,
  );
  globalThis.clearTimeout = ((timer: Parameters<typeof clearTimeout>[0]) => {
    cleared += 1;
    return originalClearTimeout(timer);
  }) as typeof clearTimeout;
  try {
    const result = await backend.exec('true');
    assert.equal(result.exitCode, 1);
    assert.equal(cleared, 1);
  } finally {
    globalThis.clearTimeout = originalClearTimeout;
  }
});

test('Tenki reconnect does not create a duplicate after auth failure', async () => {
  let created = false;
  const backend = new TenkiExecBackend(
    { type: 'tenki', project_id: 'project-test' },
    {
      ...context,
      getRuntimeState: async () => ({ tenki: { sessionId: 'old', cwd: '/home/tenki', updatedAt: 'now' } }),
      setRuntimeState: async () => undefined,
    } as never,
    {
      get: async () => { throw new UnauthorizedError('denied'); },
      createAndWait: async () => { created = true; throw new Error('must not create'); },
    } as never,
  );

  await assert.rejects(() => backend.ensure(), UnauthorizedError);
  assert.equal(created, false);
});

test('Tenki sessionless skill sync executes immediately without persistence hooks', async () => {
  let swaps = 0;
  const session = {
    id: 'session-1', state: 'RUNNING', mkdir: async () => undefined,
    run: () => {
      swaps += 1;
      return processHandle(Promise.resolve({ exitCode: 0, stdout: bytes(''), stderr: bytes('') }));
    },
    closeIfOpen: async () => undefined,
  };
  const backend = new TenkiExecBackend(
    { type: 'tenki', project_id: 'project-test' }, context as never,
    { createAndWait: async () => session } as never,
  );

  await backend.syncSkills([]);
  assert.equal(swaps, 2);
});

test('Tenki shutdown keeps live handle when pause fails', async () => {
  let creates = 0;
  const session = {
    id: 'session-1', state: 'RUNNING', mkdir: async () => undefined,
    pause: async () => { throw new Error('pause failed'); },
    run: () => processHandle(Promise.resolve({ exitCode: 0, stdout: bytes('ok'), stderr: bytes('') })),
    closeIfOpen: async () => undefined,
  };
  const backend = new TenkiExecBackend(
    { type: 'tenki', project_id: 'project-test' }, context as never,
    { createAndWait: async () => { creates += 1; return session; } } as never,
  );
  await backend.ensure();

  await assert.rejects(() => backend.shutdown(), /pause failed/);
  assert.equal((await backend.exec('true')).stdout, 'ok');
  assert.equal(creates, 1);
});

test('Tenki stat uses SDK mtime and list includes hidden entries', async () => {
  let listOptions: unknown;
  const session = {
    stat: async () => ({ path: '/x', size: 3n, mode: 0, isDir: false, modifiedUnixNs: 1_700_000_000_000_000_000n }),
    list: async (_path: string, options: unknown) => {
      listOptions = options;
      return [{ path: '/dir/.hidden', size: 2n, mode: 0, isDir: false, modifiedUnixNs: 0n }];
    },
  };
  const backend = new TenkiFileBackend();
  backend.getSession = () => session as never;

  assert.equal((await backend.stat('/home/tenki/x'))?.mtime, '2023-11-14T22:13:20.000Z');
  assert.deepEqual(await backend.list('/home/tenki/dir'), [{ name: '.hidden', type: 'file', size: 2 }]);
  assert.deepEqual(listOptions, { includeHidden: true });
});

test('Tenki delete refuses directories and transport stat errors invalidate', async () => {
  let removed = false;
  let invalidated = false;
  const backend = new TenkiFileBackend();
  backend.invalidate = () => { invalidated = true; };
  backend.getSession = () => ({
    stat: async () => ({ path: '/dir', size: 0n, mode: 0, isDir: true, modifiedUnixNs: 0n }),
    run: async () => { removed = true; return { exitCode: 0, stdout: bytes(''), stderr: bytes('') }; },
  }) as never;

  await assert.rejects(() => backend.delete('/home/tenki/dir'), ValidationError);
  assert.equal(removed, false);

  backend.getSession = () => ({ stat: async () => { throw new Error('transport'); } }) as never;
  await assert.rejects(() => backend.stat('/home/tenki/x'), /transport/);
  assert.equal(invalidated, true);
});

test('Tenki stat maps only SDK file-not-found errors to null', async () => {
  let invalidated = false;
  const backend = new TenkiFileBackend();
  backend.invalidate = () => { invalidated = true; };
  backend.getSession = () => ({
    stat: async () => { throw new FileNotFoundError('missing'); },
  }) as never;

  assert.equal(await backend.stat('/home/tenki/missing'), null);
  assert.equal(invalidated, false);
});
