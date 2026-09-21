import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { readSkillMd, type SkillArchiveReader } from '../src/skill-source.js';

const SKILL_MD = '---\nname: demo\ndescription: a demo skill\n---\nbody\n';

test('readSkillMd reads SKILL.md from a legacy bare path off disk', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'oh-skill-src-'));
  try {
    await writeFile(path.join(dir, 'SKILL.md'), SKILL_MD, 'utf8');
    const content = await readSkillMd(dir, undefined);
    assert.equal(content, SKILL_MD);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('readSkillMd returns null when a bare path has no SKILL.md', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'oh-skill-src-'));
  try {
    const content = await readSkillMd(dir, undefined);
    assert.equal(content, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('readSkillMd materializes a blob: pointer via the artifact store', async () => {
  const seen: string[] = [];
  const store: SkillArchiveReader = {
    async restoreTo(storageKey, destDir) {
      seen.push(storageKey);
      await writeFile(path.join(destDir, 'SKILL.md'), SKILL_MD, 'utf8');
    },
  };
  const content = await readSkillMd('blob:skills/system/demo.tar.gz', store);
  assert.equal(content, SKILL_MD);
  assert.deepEqual(seen, ['skills/system/demo.tar.gz']);
});

test('readSkillMd returns null for a blob: pointer with no artifact store', async () => {
  const content = await readSkillMd('blob:skills/system/demo.tar.gz', undefined);
  assert.equal(content, null);
});

test('readSkillMd returns null when the blob cannot be restored', async () => {
  const store: SkillArchiveReader = {
    async restoreTo() {
      throw new Error('not found');
    },
  };
  const content = await readSkillMd('blob:skills/system/missing.tar.gz', store);
  assert.equal(content, null);
});
