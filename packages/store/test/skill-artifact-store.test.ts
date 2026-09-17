import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { LocalAttachmentStorage } from '../src/impl/local-attachment-storage.js';
import {
  SkillArtifactStore,
  packSkillDir,
  unpackSkillTar,
} from '../src/impl/skill-artifact-store.js';

const makeSkillDir = async (): Promise<string> => {
  const dir = await mkdtemp(path.join(tmpdir(), 'oh-skill-'));
  await writeFile(path.join(dir, 'SKILL.md'), '# Test Skill\n\nDoes a thing.\n');
  await mkdir(path.join(dir, 'scripts'), { recursive: true });
  await writeFile(path.join(dir, 'scripts', 'run.sh'), '#!/bin/sh\necho hi\n');
  await writeFile(path.join(dir, 'data.json'), JSON.stringify({ k: 'v' }));
  return dir;
};

const makeStorage = async (): Promise<{ storage: LocalAttachmentStorage; root: string }> => {
  const root = await mkdtemp(path.join(tmpdir(), 'oh-blob-'));
  return { storage: new LocalAttachmentStorage({ root }), root };
};

test('packSkillDir / unpackSkillTar round-trips file tree and contents', async () => {
  const src = await makeSkillDir();
  const dest = await mkdtemp(path.join(tmpdir(), 'oh-restore-'));
  try {
    const buf = await packSkillDir(src);
    await unpackSkillTar(buf, dest);
    assert.equal(
      await readFile(path.join(dest, 'SKILL.md'), 'utf8'),
      '# Test Skill\n\nDoes a thing.\n',
    );
    assert.equal(await readFile(path.join(dest, 'scripts', 'run.sh'), 'utf8'), '#!/bin/sh\necho hi\n');
    assert.deepEqual(JSON.parse(await readFile(path.join(dest, 'data.json'), 'utf8')), { k: 'v' });
  } finally {
    await rm(src, { recursive: true, force: true });
    await rm(dest, { recursive: true, force: true });
  }
});

test('packSkillDir is content-deterministic (stable sha for dedup)', async () => {
  const src = await makeSkillDir();
  try {
    const a = await packSkillDir(src);
    const b = await packSkillDir(src);
    assert.ok(a.equals(b), 'identical contents must pack to identical bytes');
  } finally {
    await rm(src, { recursive: true, force: true });
  }
});

test('SkillArtifactStore.putSkill then restoreTo round-trips through blob storage', async () => {
  const src = await makeSkillDir();
  const { storage, root } = await makeStorage();
  const dest = await mkdtemp(path.join(tmpdir(), 'oh-restore-'));
  const store = new SkillArtifactStore(storage);
  try {
    const put = await store.putSkill({ source: 'system', slug: 'demo' }, src);
    assert.equal(put.storageKey, 'skills/system/demo.tar.gz');
    assert.equal(put.path, 'blob:skills/system/demo.tar.gz');
    assert.equal(put.skipped, false);
    assert.ok(put.sizeBytes > 0);
    assert.match(put.sha256, /^[0-9a-f]{64}$/);

    await store.restoreTo(put.storageKey, dest);
    assert.equal(
      await readFile(path.join(dest, 'SKILL.md'), 'utf8'),
      '# Test Skill\n\nDoes a thing.\n',
    );
  } finally {
    await rm(src, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
    await rm(dest, { recursive: true, force: true });
  }
});

test('putSkill skips upload when priorSha256 matches', async () => {
  const src = await makeSkillDir();
  const { storage, root } = await makeStorage();
  const store = new SkillArtifactStore(storage);
  try {
    const first = await store.putSkill({ source: 'system', slug: 'demo' }, src);
    const again = await store.putSkill({ source: 'system', slug: 'demo' }, src, {
      priorSha256: first.sha256,
    });
    assert.equal(again.skipped, true);
    assert.equal(again.sha256, first.sha256);
    assert.equal(again.path, first.path);
  } finally {
    await rm(src, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test('putSkill re-uploads (no skip) when content changed', async () => {
  const src = await makeSkillDir();
  const { storage, root } = await makeStorage();
  const store = new SkillArtifactStore(storage);
  try {
    const first = await store.putSkill({ source: 'user', slug: 's', ownerAgentId: 'a1' }, src);
    await writeFile(path.join(src, 'SKILL.md'), '# Changed\n');
    const second = await store.putSkill({ source: 'user', slug: 's', ownerAgentId: 'a1' }, src, {
      priorSha256: first.sha256,
    });
    assert.equal(second.skipped, false);
    assert.notEqual(second.sha256, first.sha256);
    assert.equal(second.storageKey, 'skills/user/a1/s.tar.gz');
  } finally {
    await rm(src, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test('LocalAttachmentStorage.putObject overwrites in place and hashes body', async () => {
  const { storage, root } = await makeStorage();
  try {
    const a = await storage.putObject({
      storageKey: 'skills/system/x.tar.gz',
      contentType: 'application/gzip',
      body: Buffer.from('one'),
    });
    assert.equal(a.sizeBytes, 3);
    const b = await storage.putObject({
      storageKey: 'skills/system/x.tar.gz',
      contentType: 'application/gzip',
      body: Buffer.from('two-longer'),
    });
    assert.equal(b.sizeBytes, 'two-longer'.length);
    // single object at the key — overwrite, not append
    const files = await readdir(path.join(root, 'skills', 'system'));
    assert.deepEqual(files, ['x.tar.gz']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
