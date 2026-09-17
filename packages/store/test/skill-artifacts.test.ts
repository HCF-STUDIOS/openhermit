import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildSkillBlobKey,
  toSkillBlobPath,
  parseSkillBlobPath,
  isSkillBlobPath,
  SKILL_BLOB_SCHEME,
} from '../src/skill-artifacts.js';

test('buildSkillBlobKey — system skill maps to skills/system/<slug>.tar.gz', () => {
  assert.equal(
    buildSkillBlobKey({ source: 'system', slug: 'web-search' }),
    'skills/system/web-search.tar.gz',
  );
});

test('buildSkillBlobKey — user skill includes the owner agent id', () => {
  assert.equal(
    buildSkillBlobKey({ source: 'user', slug: 'my-skill', ownerAgentId: 'agent_abc' }),
    'skills/user/agent_abc/my-skill.tar.gz',
  );
});

test('buildSkillBlobKey — honors a custom prefix', () => {
  assert.equal(
    buildSkillBlobKey({ source: 'system', slug: 'x' }, 'artifacts'),
    'artifacts/system/x.tar.gz',
  );
});

test('buildSkillBlobKey — is deterministic for the same ref', () => {
  const ref = { source: 'user' as const, slug: 's', ownerAgentId: 'a' };
  assert.equal(buildSkillBlobKey(ref), buildSkillBlobKey(ref));
});

test('buildSkillBlobKey — user skill without ownerAgentId throws', () => {
  assert.throws(
    () => buildSkillBlobKey({ source: 'user', slug: 'x' }),
    /ownerAgentId/,
  );
});

test('buildSkillBlobKey — rejects traversal in slug', () => {
  assert.throws(() => buildSkillBlobKey({ source: 'system', slug: '..' }), /slug/);
  assert.throws(
    () => buildSkillBlobKey({ source: 'system', slug: 'a/b' }),
    /slug/,
  );
});

test('buildSkillBlobKey — rejects traversal in ownerAgentId', () => {
  assert.throws(
    () => buildSkillBlobKey({ source: 'user', slug: 'x', ownerAgentId: '../evil' }),
    /ownerAgentId/,
  );
});

test('toSkillBlobPath / parseSkillBlobPath round-trip', () => {
  const key = 'skills/system/web-search.tar.gz';
  const path = toSkillBlobPath(key);
  assert.equal(path, `${SKILL_BLOB_SCHEME}${key}`);
  assert.equal(parseSkillBlobPath(path), key);
  assert.ok(isSkillBlobPath(path));
});

test('parseSkillBlobPath — returns null for legacy bare filesystem paths', () => {
  assert.equal(parseSkillBlobPath('/data/openhermit/skills/system/x'), null);
  assert.equal(isSkillBlobPath('/data/openhermit/skills/system/x'), false);
});
