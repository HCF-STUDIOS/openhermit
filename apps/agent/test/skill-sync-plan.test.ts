import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildSkillManifestReadScript,
  buildSkillSyncCommitScript,
  buildSkillSyncPrepareScript,
  parseSkillManifest,
  planSkillSync,
  SKILL_MANIFEST_BASENAME,
} from '../src/core/backends/shared.js';

const ROOT = '/home/user/.openhermit/skills';

const entry = (id: string, source: 'system' | 'user' = 'system') => ({
  id,
  sourcePath: `/srv/skills/${id}`,
  source,
});

test('parseSkillManifest tolerates missing and malformed manifests', () => {
  assert.deepEqual(parseSkillManifest(null), { system: [], user: [] });
  assert.deepEqual(parseSkillManifest(''), { system: [], user: [] });
  assert.deepEqual(parseSkillManifest('not json'), { system: [], user: [] });
  assert.deepEqual(parseSkillManifest('{"managed":{"system":"nope"}}'), {
    system: [],
    user: [],
  });
  assert.deepEqual(
    parseSkillManifest('{"managed":{"system":["a",7],"user":["b"]}}'),
    { system: ['a'], user: ['b'] },
  );
});

test('planSkillSync prunes only previously managed ids', () => {
  const plan = planSkillSync([entry('keep')], { system: ['keep', 'gone'], user: [] });
  assert.deepEqual(plan.prune, [{ source: 'system', id: 'gone' }]);
  assert.deepEqual(
    plan.install.map((s) => s.id),
    ['keep'],
  );
  assert.deepEqual(parseSkillManifest(plan.manifest), { system: ['keep'], user: [] });
});

test('planSkillSync prunes nothing when no manifest was found', () => {
  const plan = planSkillSync([], { system: [], user: [] });
  assert.deepEqual(plan.prune, []);
  assert.deepEqual(plan.install, []);
});

test('planSkillSync keeps sources independent', () => {
  const plan = planSkillSync([entry('shared', 'user')], {
    system: ['shared'],
    user: ['shared'],
  });
  assert.deepEqual(plan.prune, [{ source: 'system', id: 'shared' }]);
});

test('prepare script touches only pruned and reinstalled directories', () => {
  const plan = planSkillSync([entry('keep', 'user')], { system: ['gone'], user: [] });
  const script = buildSkillSyncPrepareScript(ROOT, plan);

  assert.match(script, /^set -eu$/m);
  assert.match(script, new RegExp(`mkdir -p '${ROOT}/system' '${ROOT}/user'`));
  assert.match(script, new RegExp(`rm -rf '${ROOT}/system/gone'`));
  assert.match(script, new RegExp(`rm -rf '${ROOT}/user/keep'`));
  // Never the subdirs themselves — that is what destroyed unmanaged skills.
  assert.doesNotMatch(script, new RegExp(`rm -rf '${ROOT}/system'`));
  assert.doesNotMatch(script, new RegExp(`rm -rf '${ROOT}/user'`));
});

test('commit script writes the manifest and swaps staged directories in', () => {
  const plan = planSkillSync([entry('keep', 'user')], { system: ['gone'], user: [] });
  const stage = `${ROOT}/.stage-1`;
  const script = buildSkillSyncCommitScript(ROOT, plan, stage);

  assert.match(script, new RegExp(`rm -rf '${ROOT}/system/gone'`));
  assert.match(script, new RegExp(`mv '${stage}/user/keep' '${ROOT}/user/keep'`));
  assert.match(script, new RegExp(`rm -rf '${stage}'`));

  const encoded = /printf %s '([A-Za-z0-9+/=]+)'/.exec(script)?.[1];
  assert.ok(encoded, 'manifest payload is base64 encoded');
  assert.deepEqual(parseSkillManifest(Buffer.from(encoded, 'base64').toString('utf8')), {
    system: [],
    user: ['keep'],
  });
  assert.match(script, new RegExp(`> '${ROOT}/${SKILL_MANIFEST_BASENAME}'`));
});

test('commit script without a stage only writes the manifest', () => {
  const plan = planSkillSync([], { system: ['gone'], user: [] });
  const script = buildSkillSyncCommitScript(ROOT, plan);
  assert.doesNotMatch(script, /\bmv\b/);
  assert.doesNotMatch(script, /rm -rf/);
});

test('shell scripts quote paths containing single quotes', () => {
  const weird = "/home/o'brien/.openhermit/skills";
  const plan = planSkillSync([], { system: ["it's"], user: [] });
  const script = buildSkillSyncPrepareScript(weird, plan);
  assert.ok(script.includes(`rm -rf '/home/o'\\''brien/.openhermit/skills/system/it'\\''s'`));
  assert.match(buildSkillManifestReadScript(weird), /^cat '\/home\/o'\\''brien/);
});
