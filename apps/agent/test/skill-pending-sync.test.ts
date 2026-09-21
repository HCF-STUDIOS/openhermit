import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  assertSkillSourcesReadable,
  isLegacyPendingDirty,
  PENDING_SYNC_SKILLS_KEY,
  reconcileSystemSkillsOnEnsure,
  writePendingSkillFlag,
} from '../src/core/backends/shared.js';
import type { SyncSkillEntry } from '../src/core/exec-backend.js';

/** The pre-flag per-backend key (e.g. e2b's), used to test migration. */
const LEGACY_KEY = 'e2b_pending_skills';

/** In-memory stand-in for a sandbox row's runtime_state. */
const fakeRuntimeState = (initial: Record<string, unknown> = {}) => {
  let state: Record<string, unknown> = { ...initial };
  return {
    getRuntimeState: async () => state,
    setRuntimeState: async (next: Record<string, unknown>) => {
      state = { ...next };
    },
    snapshot: () => state,
  };
};

test('assertSkillSourcesReadable passes when every source has a SKILL.md', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'oh-skill-readable-'));
  try {
    const dir = path.join(root, 'system', 'alpha');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'SKILL.md'), '# alpha', 'utf8');
    const install: SyncSkillEntry[] = [{ id: 'alpha', sourcePath: dir, source: 'system' }];
    await assert.doesNotReject(assertSkillSourcesReadable(install));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('assertSkillSourcesReadable throws listing every unreadable source', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'oh-skill-readable-'));
  try {
    const good = path.join(root, 'system', 'good');
    await mkdir(good, { recursive: true });
    await writeFile(path.join(good, 'SKILL.md'), '# good', 'utf8');

    const install: SyncSkillEntry[] = [
      { id: 'good', sourcePath: good, source: 'system' },
      { id: 'ghost', sourcePath: path.join(root, 'system', 'ghost'), source: 'system' },
      { id: 'phantom', sourcePath: path.join(root, 'user', 'phantom'), source: 'user' },
    ];
    await assert.rejects(assertSkillSourcesReadable(install), (err: Error) => {
      assert.match(err.message, /unreadable/);
      assert.match(err.message, /system\/ghost/);
      assert.match(err.message, /user\/phantom/);
      assert.doesNotMatch(err.message, /system\/good/);
      return true;
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('isLegacyPendingDirty honors the pre-flag record shapes', () => {
  // Legacy record with a queued list → dirty only when non-empty.
  assert.equal(isLegacyPendingDirty({ skills: [{ id: 'a' }], queuedAt: 'x' }), true);
  assert.equal(isLegacyPendingDirty({ skills: [], queuedAt: 'x' }), false);
  // Legacy-ish object with no skills array is treated as dirty (be safe).
  assert.equal(isLegacyPendingDirty({ queuedAt: 'x' }), true);
  // Bare true (defensive) → dirty.
  assert.equal(isLegacyPendingDirty(true), true);
  // Absent / falsy → clean.
  assert.equal(isLegacyPendingDirty(undefined), false);
  assert.equal(isLegacyPendingDirty(null), false);
  assert.equal(isLegacyPendingDirty(false), false);
});

test('writePendingSkillFlag sets and clears the new flag, preserving other state', async () => {
  const rt = fakeRuntimeState({ e2b: { sandboxId: 'sb-1' } });

  await writePendingSkillFlag(rt, true);
  assert.equal(rt.snapshot()[PENDING_SYNC_SKILLS_KEY], true);
  assert.deepEqual(rt.snapshot().e2b, { sandboxId: 'sb-1' });

  await writePendingSkillFlag(rt, false);
  assert.ok(!(PENDING_SYNC_SKILLS_KEY in rt.snapshot()));
  assert.deepEqual(rt.snapshot().e2b, { sandboxId: 'sb-1' });
});

test('writePendingSkillFlag is a no-op without runtime state access', async () => {
  await assert.doesNotReject(writePendingSkillFlag({}, true));
});

const oneSkill = async (): Promise<{
  skills: SyncSkillEntry[];
  cleanup: () => Promise<void>;
}> => ({
  skills: [{ id: 'alpha', sourcePath: '/does/not/matter', source: 'system' }],
  cleanup: async () => {},
});

const reconcile = (
  rt: ReturnType<typeof fakeRuntimeState>,
  fresh: boolean,
  overrides: Partial<Parameters<typeof reconcileSystemSkillsOnEnsure>[0]> = {},
) =>
  reconcileSystemSkillsOnEnsure({
    fresh,
    label: 'test',
    legacyPendingKey: LEGACY_KEY,
    getRuntimeState: rt.getRuntimeState,
    setRuntimeState: rt.setRuntimeState,
    getEnabledSystemSkills: oneSkill,
    apply: async () => {},
    ...overrides,
  });

test('reconcile on a fresh sandbox always applies and leaves the flag clear', async () => {
  const rt = fakeRuntimeState();
  const applied: SyncSkillEntry[][] = [];
  await reconcile(rt, true, {
    apply: async (s) => {
      applied.push(s);
    },
  });
  assert.equal(applied.length, 1);
  assert.equal(applied[0]![0]!.id, 'alpha');
  assert.ok(!(PENDING_SYNC_SKILLS_KEY in rt.snapshot()));
});

test('reconcile on a clean resume skips the sync entirely', async () => {
  const rt = fakeRuntimeState();
  let called = false;
  await reconcile(rt, false, {
    apply: async () => {
      called = true;
    },
  });
  assert.equal(called, false);
});

test('reconcile on a resume with the new flag applies and clears it', async () => {
  const rt = fakeRuntimeState({ [PENDING_SYNC_SKILLS_KEY]: true });
  let called = false;
  await reconcile(rt, false, {
    apply: async () => {
      called = true;
    },
  });
  assert.equal(called, true);
  assert.ok(!(PENDING_SYNC_SKILLS_KEY in rt.snapshot()));
});

test('reconcile migrates a legacy non-empty pending record and sweeps both keys', async () => {
  // Pre-flag production data: an object with a queued skill list + host paths.
  const rt = fakeRuntimeState({
    [LEGACY_KEY]: {
      skills: [{ id: 'old', sourcePath: '/tmp/oh-skill-stage-gone/system/old', source: 'system' }],
      queuedAt: '2026-01-01T00:00:00.000Z',
    },
  });
  let called = false;
  await reconcile(rt, false, {
    apply: async () => {
      called = true;
    },
  });
  assert.equal(called, true);
  // Both the new flag and the stale legacy entry are gone after success.
  assert.ok(!(PENDING_SYNC_SKILLS_KEY in rt.snapshot()));
  assert.ok(!(LEGACY_KEY in rt.snapshot()));
});

test('reconcile ignores a legacy record with an empty queued list', async () => {
  const rt = fakeRuntimeState({ [LEGACY_KEY]: { skills: [], queuedAt: 'x' } });
  let called = false;
  await reconcile(rt, false, {
    apply: async () => {
      called = true;
    },
  });
  assert.equal(called, false);
});

test('reconcile without a skill resolver never applies (avoids pruning everything)', async () => {
  const rt = fakeRuntimeState({ [PENDING_SYNC_SKILLS_KEY]: true });
  let called = false;
  await reconcile(rt, true, {
    getEnabledSystemSkills: undefined,
    apply: async () => {
      called = true;
    },
  });
  assert.equal(called, false);
  // Flag is left untouched so a later ensure with a resolver still retries.
  assert.equal(rt.snapshot()[PENDING_SYNC_SKILLS_KEY], true);
});

test('reconcile keeps the flag set and swallows errors when apply fails', async () => {
  const rt = fakeRuntimeState({ [PENDING_SYNC_SKILLS_KEY]: true });
  let cleaned = false;
  await assert.doesNotReject(
    reconcile(rt, false, {
      getEnabledSystemSkills: async () => ({
        skills: [{ id: 'alpha', sourcePath: '/x', source: 'system' }],
        cleanup: async () => {
          cleaned = true;
        },
      }),
      apply: async () => {
        throw new Error('upload blew up');
      },
    }),
  );
  // Failure must not clear the flag — the next ensure retries.
  assert.equal(rt.snapshot()[PENDING_SYNC_SKILLS_KEY], true);
  // Materialized temp dirs are still cleaned up even on failure.
  assert.equal(cleaned, true);
});
