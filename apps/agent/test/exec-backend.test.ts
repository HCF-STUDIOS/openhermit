import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { ValidationError, NotFoundError } from '@openhermit/shared';

import {
  ExecBackendManager,
  createExecBackend,
  HostFileBackend,
  type ExecBackend,
  type BackendFactoryContext,
} from '../src/core/index.js';
import type { DockerRunner, DockerContainerManager } from '../src/core/container-manager.js';

const fakeContext: BackendFactoryContext = {
  containerManager: {} as DockerContainerManager,
  agentId: 'test-agent',
  workspaceDir: '/tmp/workspace',
};

// ── createExecBackend ────────────────────────────────────────────────────

test('createExecBackend rejects the removed host backend', () => {
  assert.throws(
    () => createExecBackend({ type: 'host', id: 'host' } as any, fakeContext),
    ValidationError,
  );
});

test('createExecBackend throws for unknown type', () => {
  assert.throws(
    () => createExecBackend({ type: 'unknown' } as any, fakeContext),
    ValidationError,
  );
});

// ── ExecBackendManager ───────────────────────────────────────────────────

const makeFakeBackend = (id: string, type = 'docker'): ExecBackend => ({
  id,
  type,
  label: id,
  username: 'tester',
  agentHome: '/tmp/fake',
  ensure: async () => {},
  exec: async () => ({ stdout: '', stderr: '', exitCode: 0, durationMs: 0 }),
  syncSkills: async () => {},
  shutdown: async () => {},
  files: {
    read: async () => { throw new Error('not used'); },
    write: async () => { throw new Error('not used'); },
    list: async () => [],
    stat: async () => null,
    delete: async () => { throw new Error('not used'); },
  },
});

test('ExecBackendManager throws on empty backends', () => {
  assert.throws(() => new ExecBackendManager([]), ValidationError);
});

test('ExecBackendManager uses first backend as default', () => {
  const mgr = new ExecBackendManager([makeFakeBackend('a'), makeFakeBackend('b')]);
  assert.equal(mgr.getDefault().id, 'a');
});

test('ExecBackendManager respects explicit default', () => {
  const mgr = new ExecBackendManager([makeFakeBackend('a'), makeFakeBackend('b')], 'b');
  assert.equal(mgr.getDefault().id, 'b');
});

test('ExecBackendManager throws on invalid default', () => {
  assert.throws(
    () => new ExecBackendManager([makeFakeBackend('a')], 'missing'),
    ValidationError,
  );
});

test('ExecBackendManager.get throws for unknown id', () => {
  const mgr = new ExecBackendManager([makeFakeBackend('a')]);
  assert.throws(() => mgr.get('nope'), NotFoundError);
});

test('ExecBackendManager.list returns all backends', () => {
  const mgr = new ExecBackendManager([makeFakeBackend('a'), makeFakeBackend('b')]);
  assert.equal(mgr.list().length, 2);
});

test('ExecBackendManager.fromConfig throws when no backend is configured', () => {
  // The removed `host` default used to be injected here; there is no implicit
  // fallback anymore — an agent with no sandbox has no exec environment.
  assert.throws(() => ExecBackendManager.fromConfig(undefined, fakeContext), ValidationError);
  assert.throws(
    () => ExecBackendManager.fromConfig({ backends: [] }, fakeContext),
    ValidationError,
  );
});

test('ExecBackendManager.fromConfig auto-assigns ids', () => {
  const mgr = ExecBackendManager.fromConfig(
    { backends: [{ type: 'docker', image: 'ubuntu:24.04' }, { type: 'docker', image: 'ubuntu:24.04' }] },
    fakeContext,
  );
  const ids = mgr.list().map((b) => b.id);
  assert.equal(ids.length, 2);
  assert.notEqual(ids[0], ids[1]);
});

const fakeSandboxAccess = {
  getRuntimeState: async () => null,
  setRuntimeState: async () => {},
  markActive: async () => {},
};

test('ExecBackendManager.fromSandboxRows drops rows with an unsupported backend type', () => {
  const mgr = ExecBackendManager.fromSandboxRows(
    [
      { id: 's1', alias: 'h', type: 'host', config: {} },
      { id: 's2', alias: 'default', type: 'docker', config: { image: 'ubuntu:24.04' } },
    ],
    fakeContext,
    fakeSandboxAccess,
  );
  const ids = mgr.list().map((b) => b.id);
  assert.deepEqual(ids, ['default']);
});

test('ExecBackendManager.fromSandboxRows throws when every row is unsupported', () => {
  assert.throws(
    () =>
      ExecBackendManager.fromSandboxRows(
        [{ id: 's1', alias: 'h', type: 'host', config: {} }],
        fakeContext,
        fakeSandboxAccess,
      ),
    ValidationError,
  );
});

test('ExecBackendManager.shutdownAll calls all backends', async () => {
  let shutdownCount = 0;
  const backend = (): ExecBackend => ({
    ...makeFakeBackend('x'),
    id: `b-${shutdownCount++}`,
    shutdown: async () => { shutdownCount++; },
  });
  const mgr = new ExecBackendManager([backend(), backend()]);
  shutdownCount = 0;
  await mgr.shutdownAll();
  assert.equal(shutdownCount, 2);
});

// ── File backend (HostFileBackend) ─────────────────────────────────────────
// HostFileBackend is the shared filesystem layer (docker uses it via a
// bind-mount with path translation). With hostRoot === containerRoot the
// translation is a no-op but the boundary / symlink-escape checks still apply.

test('HostFileBackend: read/write/stat/list/delete round-trip', async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'oh-fs-host-'));
  try {
    const files = new HostFileBackend(tmp, tmp);
    await files.write(path.join(tmp, 'a.txt'), Buffer.from('hello'), 'overwrite');
    const r = await files.read(path.join(tmp, 'a.txt'));
    assert.equal(r.data.toString(), 'hello');
    const s = await files.stat(path.join(tmp, 'a.txt'));
    assert.equal(s?.type, 'file');
    assert.equal(s?.size, 5);
    const list = await files.list(tmp);
    assert.ok(list.some((e) => e.name === 'a.txt' && e.type === 'file'));
    await files.delete(path.join(tmp, 'a.txt'));
    assert.equal(await files.stat(path.join(tmp, 'a.txt')), null);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('HostFileBackend: rejects paths outside the root', async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'oh-fs-host-'));
  try {
    const files = new HostFileBackend(tmp, tmp);
    await assert.rejects(() => files.read('/etc/passwd'), ValidationError);
    await assert.rejects(() => files.read('relative/path'), ValidationError);
    await assert.rejects(() => files.read(`${tmp}/../escape`), ValidationError);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('HostFileBackend: create mode fails when file exists', async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'oh-fs-host-'));
  try {
    const files = new HostFileBackend(tmp, tmp);
    await files.write(path.join(tmp, 'x'), Buffer.from('1'), 'create');
    await assert.rejects(
      () => files.write(path.join(tmp, 'x'), Buffer.from('2'), 'create'),
      ValidationError,
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('HostFileBackend: append mode concatenates', async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'oh-fs-host-'));
  try {
    const files = new HostFileBackend(tmp, tmp);
    await files.write(path.join(tmp, 'x'), Buffer.from('foo'), 'overwrite');
    await files.write(path.join(tmp, 'x'), Buffer.from('bar'), 'append');
    const r = await files.read(path.join(tmp, 'x'));
    assert.equal(r.data.toString(), 'foobar');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('docker file backend: container path translates to host workspaceDir', async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'oh-fs-docker-'));
  try {
    // Pre-create a file at the host bind-mount path that *would* appear at
    // /root/note.txt inside the container (DOCKER_DEFAULT_AGENT_HOME=/root).
    await writeFile(path.join(tmp, 'note.txt'), 'inside container');
    const ctx: BackendFactoryContext = {
      containerManager: {} as DockerContainerManager,
      agentId: 'test-agent',
      workspaceDir: tmp,
    };
    const backend = createExecBackend(
      { type: 'docker', image: 'ubuntu:24.04' },
      ctx,
    );
    const r = await backend.files.read('/root/note.txt');
    assert.equal(r.data.toString(), 'inside container');

    await backend.files.write('/root/sub/x', Buffer.from('hi'), 'overwrite');
    const onHost = await readFile(path.join(tmp, 'sub', 'x'), 'utf8');
    assert.equal(onHost, 'hi');

    await assert.rejects(() => backend.files.read('/etc/hostname'), ValidationError);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('HostFileBackend: symlink escape is blocked', async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'oh-fs-escape-'));
  const outside = await mkdtemp(path.join(tmpdir(), 'oh-fs-outside-'));
  try {
    await writeFile(path.join(outside, 'secret.txt'), 'sensitive data');
    await symlink(outside, path.join(tmp, 'escape'));

    const files = new HostFileBackend(tmp, tmp);
    await assert.rejects(
      () => files.read(path.join(tmp, 'escape', 'secret.txt')),
      ValidationError,
    );
    await assert.rejects(
      () => files.write(path.join(tmp, 'escape', 'pwned.txt'), Buffer.from('x'), 'overwrite'),
      ValidationError,
    );
    await assert.rejects(
      () => files.list(path.join(tmp, 'escape')),
      ValidationError,
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
