import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import {
  createExecBackend,
  type BackendFactoryContext,
} from '../src/core/exec-backend.js';
import type { DockerContainerManager } from '../src/core/container-manager.js';
import { createTempDir } from './helpers.js';

const fakeContext = (workspaceDir: string): BackendFactoryContext => ({
  containerManager: {} as DockerContainerManager,
  agentId: 'agent-1',
  workspaceDir,
});

const systemDir = (agentHome: string): string =>
  path.join(agentHome, '.openhermit', 'skills', 'system');

const userDir = (agentHome: string): string =>
  path.join(agentHome, '.openhermit', 'skills', 'user');

// HostExecBackend writes skills to <cwd>/.openhermit/skills/system. Use the
// `cwd` override to point at a temp dir so we don't touch $HOME.

test('host backend syncSkills copies skill directories into agentHome', async (t) => {
  const home = await createTempDir(t, 'home-');
  const sourceDir = await createTempDir(t, 'source-');
  const skillSrc = path.join(sourceDir, 'skill-a');
  await fs.mkdir(skillSrc);
  await fs.writeFile(path.join(skillSrc, 'SKILL.md'), 'content');

  const backend = createExecBackend({ type: 'host', id: 'host', cwd: home }, fakeContext(home));
  await backend.syncSkills([{ id: 'skill-a', sourcePath: skillSrc, source: 'system' }]);

  const copied = await fs.readFile(path.join(systemDir(home), 'skill-a', 'SKILL.md'), 'utf8');
  assert.equal(copied, 'content');
});

test('host backend syncSkills removes stale entries', async (t) => {
  const home = await createTempDir(t, 'home-');
  const dir = systemDir(home);
  await fs.mkdir(dir, { recursive: true });
  await fs.mkdir(path.join(dir, 'old-skill'));
  await fs.writeFile(path.join(dir, 'old-skill', 'SKILL.md'), 'stale');

  const backend = createExecBackend({ type: 'host', id: 'host', cwd: home }, fakeContext(home));
  await backend.syncSkills([]);

  const entries = await fs.readdir(dir);
  assert.equal(entries.length, 0);
});

test('host backend syncSkills creates system dir if missing', async (t) => {
  const home = await createTempDir(t, 'home-');

  const backend = createExecBackend({ type: 'host', id: 'host', cwd: home }, fakeContext(home));
  await backend.syncSkills([]);

  const stat = await fs.stat(systemDir(home));
  assert.ok(stat.isDirectory());
});

test('host backend syncSkills replaces existing copy with updated content', async (t) => {
  const home = await createTempDir(t, 'home-');
  const sourceDir = await createTempDir(t, 'source-');
  const skillSrc = path.join(sourceDir, 'skill-b');
  await fs.mkdir(skillSrc);
  await fs.writeFile(path.join(skillSrc, 'SKILL.md'), 'v1');

  const backend = createExecBackend({ type: 'host', id: 'host', cwd: home }, fakeContext(home));
  await backend.syncSkills([{ id: 'skill-b', sourcePath: skillSrc, source: 'system' }]);

  await fs.writeFile(path.join(skillSrc, 'SKILL.md'), 'v2');
  await backend.syncSkills([{ id: 'skill-b', sourcePath: skillSrc, source: 'system' }]);

  const content = await fs.readFile(path.join(systemDir(home), 'skill-b', 'SKILL.md'), 'utf8');
  assert.equal(content, 'v2');
});

test('docker backend syncSkills writes to workspaceDir/.openhermit/skills/system', async (t) => {
  const workspaceDir = await createTempDir(t, 'workspace-');
  const sourceDir = await createTempDir(t, 'source-');
  const skillSrc = path.join(sourceDir, 'skill-c');
  await fs.mkdir(skillSrc);
  await fs.writeFile(path.join(skillSrc, 'SKILL.md'), 'docker-content');

  const backend = createExecBackend(
    { type: 'docker', id: 'docker', image: 'ubuntu:24.04' },
    fakeContext(workspaceDir),
  );
  await backend.syncSkills([{ id: 'skill-c', sourcePath: skillSrc, source: 'system' }]);

  const copied = await fs.readFile(
    path.join(systemDir(workspaceDir), 'skill-c', 'SKILL.md'),
    'utf8',
  );
  assert.equal(copied, 'docker-content');
});

test('host backend syncSkills dispatches by source: user → user/, system → system/', async (t) => {
  const home = await createTempDir(t, 'home-');
  const sourceDir = await createTempDir(t, 'source-');

  const sysSrc = path.join(sourceDir, 'sys-skill');
  await fs.mkdir(sysSrc);
  await fs.writeFile(path.join(sysSrc, 'SKILL.md'), 'sys');

  const userSrc = path.join(sourceDir, 'user-skill');
  await fs.mkdir(userSrc);
  await fs.writeFile(path.join(userSrc, 'SKILL.md'), 'usr');

  const backend = createExecBackend({ type: 'host', id: 'host', cwd: home }, fakeContext(home));
  await backend.syncSkills([
    { id: 'sys-skill', sourcePath: sysSrc, source: 'system' },
    { id: 'user-skill', sourcePath: userSrc, source: 'user' },
  ]);

  assert.equal(
    await fs.readFile(path.join(systemDir(home), 'sys-skill', 'SKILL.md'), 'utf8'),
    'sys',
  );
  assert.equal(
    await fs.readFile(path.join(userDir(home), 'user-skill', 'SKILL.md'), 'utf8'),
    'usr',
  );
});

test('host backend syncSkills removes stale entries from both source subdirs', async (t) => {
  const home = await createTempDir(t, 'home-');
  // Pre-seed an old user skill that should be cleaned up.
  await fs.mkdir(path.join(userDir(home), 'old-user-skill'), { recursive: true });
  await fs.writeFile(path.join(userDir(home), 'old-user-skill', 'SKILL.md'), 'stale');

  const backend = createExecBackend({ type: 'host', id: 'host', cwd: home }, fakeContext(home));
  await backend.syncSkills([]);

  // user/ is created and the stale entry is gone.
  assert.deepEqual(await fs.readdir(userDir(home)), []);
});
