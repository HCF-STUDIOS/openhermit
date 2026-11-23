import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { ValidationError } from '@openhermit/shared';

import { HostFileBackend } from '../src/core/backends/file-backend.js';
import { cwdWithinScope, resolveExecMatches } from '../src/core/policy.js';

// ── HostFileBackend symlink escapes ─────────────────────────────────────

const withDirs = async (fn: (root: string, outside: string) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(path.join(tmpdir(), 'oh-escape-root-'));
  const outside = await mkdtemp(path.join(tmpdir(), 'oh-escape-out-'));
  try {
    await fn(root, outside);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
};

test('HostFileBackend: write through a symlinked dir into a missing subdir is refused', async () => {
  await withDirs(async (root, outside) => {
    await symlink(outside, path.join(root, 'link'));
    const files = new HostFileBackend(root, root);
    // `link/new` doesn't exist, so the old immediate-parent check swallowed
    // ENOENT and mkdir -p created `new` on the far side of the link.
    await assert.rejects(
      () => files.write(path.join(root, 'link', 'new', 'pwn.txt'), Buffer.from('x'), 'overwrite'),
      ValidationError,
    );
    assert.equal(existsSync(path.join(outside, 'new')), false);
  });
});

test('HostFileBackend: write to a dangling symlink is refused', async () => {
  await withDirs(async (root, outside) => {
    const target = path.join(outside, 'created-by-attacker.txt');
    await symlink(target, path.join(root, 'dangling'));
    const files = new HostFileBackend(root, root);
    for (const mode of ['overwrite', 'append', 'create'] as const) {
      await assert.rejects(
        () => files.write(path.join(root, 'dangling'), Buffer.from('x'), mode),
        ValidationError,
        mode,
      );
    }
    assert.equal(existsSync(target), false);
  });
});

test('HostFileBackend: reading through a symlink out of the root is refused', async () => {
  await withDirs(async (root, outside) => {
    await writeFile(path.join(outside, 'secret'), 'top secret');
    await symlink(path.join(outside, 'secret'), path.join(root, 'peek'));
    const files = new HostFileBackend(root, root);
    await assert.rejects(() => files.read(path.join(root, 'peek')), ValidationError);
  });
});

test('HostFileBackend: nested new directories inside the root still work', async () => {
  await withDirs(async (root) => {
    await mkdir(path.join(root, 'real'));
    await symlink(path.join(root, 'real'), path.join(root, 'inner-link'));
    const files = new HostFileBackend(root, root);
    await files.write(path.join(root, 'a', 'b', 'c.txt'), Buffer.from('ok'), 'overwrite');
    await files.write(path.join(root, 'inner-link', 'd', 'e.txt'), Buffer.from('ok'), 'create');
    await files.write(path.join(root, 'a', 'b', 'c.txt'), Buffer.from('+'), 'append');
    assert.equal((await files.read(path.join(root, 'a', 'b', 'c.txt'))).data.toString(), 'ok+');
    assert.equal((await files.read(path.join(root, 'real', 'd', 'e.txt'))).data.toString(), 'ok');
  });
});

test('HostFileBackend: an open whose parent was swapped for an outside symlink is refused', async () => {
  // Simulates the state right after a parent-directory swap: the checks in
  // resolve()/write() passed earlier, but by open() time `dir` points out of
  // the root. openVerified must reject the descriptor before any I/O.
  await withDirs(async (root, outside) => {
    await writeFile(path.join(outside, 'victim'), 'original');
    await symlink(outside, path.join(root, 'dir'));
    const files = new HostFileBackend(root, root) as unknown as {
      openVerified: (p: string, flags: number) => Promise<unknown>;
    };
    const { constants } = await import('node:fs');
    await assert.rejects(
      () => files.openVerified(path.join(root, 'dir', 'victim'), constants.O_WRONLY | constants.O_CREAT),
      ValidationError,
    );
    await assert.rejects(
      () => files.openVerified(path.join(root, 'dir', 'victim'), constants.O_RDONLY),
      ValidationError,
    );
    const { readFile } = await import('node:fs/promises');
    assert.equal(await readFile(path.join(outside, 'victim'), 'utf8'), 'original');
  });
});

// ── exec policy cwd scoping ─────────────────────────────────────────────

test('cwdWithinScope: matches on segment boundaries after normalization', () => {
  assert.equal(cwdWithinScope('/data', '/data'), true);
  assert.equal(cwdWithinScope('/data/sub', '/data'), true);
  assert.equal(cwdWithinScope('/data/sub', '/data/'), true);
  assert.equal(cwdWithinScope('/data-secret', '/data'), false, 'sibling with shared prefix');
  assert.equal(cwdWithinScope('/data/../etc', '/data'), false, 'dot-dot escape');
  assert.equal(cwdWithinScope('/data/./x//y', '/data'), true);
  assert.equal(cwdWithinScope('/anything', '/'), true);
});

test('resolveExecMatches: an allow rule for /workspace does not cover /workspace-other or ../', () => {
  const rows = [
    {
      effect: 'allow',
      scope: { sandbox: 'primary', command: '*', cwd: '/workspace' },
      grants: [{ type: 'any' }],
    },
  ] as never;
  assert.ok(resolveExecMatches(rows, 'primary', 'ls', '/workspace/project'));
  assert.equal(resolveExecMatches(rows, 'primary', 'ls', '/workspace-other'), undefined);
  assert.equal(resolveExecMatches(rows, 'primary', 'ls', '/workspace/../etc'), undefined);
});

test('resolveExecMatches: a deny rule still catches non-normalized paths into its directory', () => {
  const rows = [
    {
      effect: 'deny',
      scope: { sandbox: 'primary', command: '*', cwd: '/secrets' },
      grants: [{ type: 'any' }],
    },
  ] as never;
  const m = resolveExecMatches(rows, 'primary', 'cat x', '/tmp/../secrets/./keys');
  assert.equal(m?.[0]?.effect, 'deny');
});
