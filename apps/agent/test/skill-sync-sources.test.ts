import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  assertSkillSourcesReadable,
  materializeQueuedSkills,
} from '../src/core/backends/shared.js';
import type { SyncSkillEntry } from '../src/core/exec-backend.js';

const withTempDir = async (fn: (dir: string) => Promise<void>): Promise<void> => {
  const dir = await mkdtemp(path.join(tmpdir(), 'oh-skill-src-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

test('assertSkillSourcesReadable accepts real skill directories', async () => {
  await withTempDir(async (dir) => {
    const sourcePath = path.join(dir, 'amiko');
    await mkdir(sourcePath, { recursive: true });
    await writeFile(path.join(sourcePath, 'SKILL.md'), '# amiko', 'utf8');
    await assertSkillSourcesReadable([{ id: 'amiko', source: 'system', sourcePath }]);
  });
});

test('assertSkillSourcesReadable rejects a source that no longer exists', async () => {
  await withTempDir(async (dir) => {
    await assertSkillSourcesReadable([
      { id: 'amiko', source: 'system', sourcePath: path.join(dir, 'gone') },
    ]).then(
      () => assert.fail('expected a missing source to throw'),
      (error: unknown) => {
        assert.match(String(error), /source is missing/);
        assert.match(String(error), /system\/amiko/);
      },
    );
  });
});

test('assertSkillSourcesReadable rejects an unmaterialized blob: pointer', async () => {
  await assertSkillSourcesReadable([
    { id: 'amiko', source: 'system', sourcePath: 'blob:system/amiko.tar.gz' },
  ]).then(
    () => assert.fail('expected a blob: pointer to throw'),
    (error: unknown) => assert.match(String(error), /was not materialized/),
  );
});

test('materializeQueuedSkills passes filesystem paths through untouched', async () => {
  const skills: SyncSkillEntry[] = [
    { id: 'amiko', source: 'system', sourcePath: '/srv/skills/amiko' },
  ];
  const result = await materializeQueuedSkills(skills, async () => {
    assert.fail('should not materialize when no blob: paths are queued');
  });
  assert.deepEqual(result.skills, skills);
  await result.cleanup();
});

test('materializeQueuedSkills re-stages queued blob: pointers', async () => {
  const queued: SyncSkillEntry[] = [
    { id: 'amiko', source: 'system', sourcePath: 'blob:system/amiko.tar.gz' },
  ];
  let cleaned = false;
  const result = await materializeQueuedSkills(queued, async (skills) => ({
    skills: skills.map((skill) => ({
      ...skill,
      sourcePath: '/stage/system/amiko',
      originPath: skill.sourcePath,
    })),
    cleanup: async () => {
      cleaned = true;
    },
  }));
  assert.deepEqual(result.skills, [
    {
      id: 'amiko',
      source: 'system',
      sourcePath: '/stage/system/amiko',
      originPath: 'blob:system/amiko.tar.gz',
    },
  ]);
  await result.cleanup();
  assert.equal(cleaned, true);
});

test('materializeQueuedSkills fails loudly when the backend cannot materialize', async () => {
  await materializeQueuedSkills(
    [{ id: 'amiko', source: 'system', sourcePath: 'blob:system/amiko.tar.gz' }],
    undefined,
  ).then(
    () => assert.fail('expected an unmaterializable blob: path to throw'),
    (error: unknown) => assert.match(String(error), /cannot materialize/),
  );
});
