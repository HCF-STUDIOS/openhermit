import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { parseFrontmatter, scanSkillDirectory, loadSkillIndex, formatSkillsPromptSection } from '../src/skills.js';
import type { SkillIndexEntry } from '../src/skills.js';
import { createTempDir } from './helpers.js';

// ── parseFrontmatter ─────────────────────────────────────────────────────

test('parseFrontmatter extracts key-value pairs', () => {
  const content = '---\nname: My Skill\ndescription: Does things\n---\n\nBody text.';
  const fm = parseFrontmatter(content);
  assert.equal(fm.name, 'My Skill');
  assert.equal(fm.description, 'Does things');
});

test('parseFrontmatter returns empty object when no frontmatter', () => {
  assert.deepEqual(parseFrontmatter('No frontmatter here'), {});
});

test('parseFrontmatter handles colons in values', () => {
  const content = '---\nname: Skill: Advanced\n---\n';
  const fm = parseFrontmatter(content);
  assert.equal(fm.name, 'Skill: Advanced');
});

test('parseFrontmatter handles Windows line endings', () => {
  const content = '---\r\nname: Test\r\ndescription: Hello\r\n---\r\n';
  const fm = parseFrontmatter(content);
  assert.equal(fm.name, 'Test');
  assert.equal(fm.description, 'Hello');
});

// ── scanSkillDirectory ───────────────────────────────────────────────────

test('scanSkillDirectory finds skills with SKILL.md', async (t) => {
  const dir = await createTempDir(t, 'skills-scan-');
  const skillDir = path.join(dir, 'my-skill');
  await fs.mkdir(skillDir);
  await fs.writeFile(
    path.join(skillDir, 'SKILL.md'),
    '---\nname: My Skill\ndescription: A test skill\n---\nContent.',
  );

  const skills = await scanSkillDirectory(dir, '/skills', 'system');
  assert.equal(skills.length, 1);
  assert.equal(skills[0]!.id, 'my-skill');
  assert.equal(skills[0]!.name, 'My Skill');
  assert.equal(skills[0]!.description, 'A test skill');
  assert.equal(skills[0]!.path, '/skills/my-skill');
  assert.equal(skills[0]!.source, 'system');
});

test('scanSkillDirectory skips skills without description', async (t) => {
  const dir = await createTempDir(t, 'skills-scan-');
  const skillDir = path.join(dir, 'no-desc');
  await fs.mkdir(skillDir);
  await fs.writeFile(path.join(skillDir, 'SKILL.md'), '---\nname: No Desc\n---\n');

  const skills = await scanSkillDirectory(dir, '/skills', 'system');
  assert.equal(skills.length, 0);
});

test('scanSkillDirectory returns empty for non-existent directory', async () => {
  const skills = await scanSkillDirectory('/tmp/nonexistent-skills-dir-xyz', '/skills', 'system');
  assert.deepEqual(skills, []);
});

test('scanSkillDirectory uses directory name as fallback name', async (t) => {
  const dir = await createTempDir(t, 'skills-scan-');
  const skillDir = path.join(dir, 'fallback-name');
  await fs.mkdir(skillDir);
  await fs.writeFile(path.join(skillDir, 'SKILL.md'), '---\ndescription: Has desc\n---\n');

  const skills = await scanSkillDirectory(dir, '/skills', 'workspace');
  assert.equal(skills.length, 1);
  assert.equal(skills[0]!.name, 'fallback-name');
  assert.equal(skills[0]!.source, 'workspace');
});

// ── loadSkillIndex ───────────────────────────────────────────────────────

test('loadSkillIndex merges DB and workspace skills', async (t) => {
  const workspaceRoot = await createTempDir(t, 'workspace-');
  const wsSkillsDir = path.join(workspaceRoot, '.openhermit', 'skills', 'ws-skill');
  await fs.mkdir(wsSkillsDir, { recursive: true });
  await fs.writeFile(
    path.join(wsSkillsDir, 'SKILL.md'),
    '---\nname: WS Skill\ndescription: From workspace\n---\n',
  );

  const fakeStore = {
    listEnabled: async () => [
      { id: 'db-skill', name: 'DB Skill', description: 'From DB', path: '/some/path' },
    ],
  };

  const skills = await loadSkillIndex('agent-1', workspaceRoot, fakeStore as any);
  assert.equal(skills.length, 2);
  const ids = skills.map((s) => s.id);
  assert.ok(ids.includes('db-skill'));
  assert.ok(ids.includes('ws-skill'));
});

test('loadSkillIndex workspace skills take priority over DB skills with same id', async (t) => {
  const workspaceRoot = await createTempDir(t, 'workspace-');
  const wsSkillsDir = path.join(workspaceRoot, '.openhermit', 'skills', 'shared');
  await fs.mkdir(wsSkillsDir, { recursive: true });
  await fs.writeFile(
    path.join(wsSkillsDir, 'SKILL.md'),
    '---\nname: WS Version\ndescription: From workspace\n---\n',
  );

  const fakeStore = {
    listEnabled: async () => [
      { id: 'shared', name: 'DB Version', description: 'From DB', path: '/db/path' },
    ],
  };

  const skills = await loadSkillIndex('agent-1', workspaceRoot, fakeStore as any);
  assert.equal(skills.length, 1);
  assert.equal(skills[0]!.name, 'WS Version');
  assert.equal(skills[0]!.source, 'workspace');
});

test('loadSkillIndex skips the system/ subdir when scanning workspace skills', async (t) => {
  const workspaceRoot = await createTempDir(t, 'workspace-');
  const sysSkillDir = path.join(workspaceRoot, '.openhermit', 'skills', 'system', 'sys-only');
  await fs.mkdir(sysSkillDir, { recursive: true });
  await fs.writeFile(
    path.join(sysSkillDir, 'SKILL.md'),
    '---\nname: Sys Only\ndescription: System skill copied in\n---\n',
  );

  // No DB store: workspace scan must not pick up files under system/.
  const skills = await loadSkillIndex('agent-1', workspaceRoot);
  assert.deepEqual(skills, []);
});

test('loadSkillIndex works without skill store', async (t) => {
  const workspaceRoot = await createTempDir(t, 'workspace-');
  const skills = await loadSkillIndex('agent-1', workspaceRoot);
  assert.deepEqual(skills, []);
});

// ── formatSkillsPromptSection ────────────────────────────────────────────

test('formatSkillsPromptSection returns undefined for empty list', () => {
  assert.equal(formatSkillsPromptSection([]), undefined);
});

test('formatSkillsPromptSection formats skills as markdown', () => {
  const skills: SkillIndexEntry[] = [
    { id: 'test', name: 'Test', description: 'A test', path: '/skills/test', source: 'system' },
  ];
  const section = formatSkillsPromptSection(skills)!;
  assert.ok(section.includes('## Skills'));
  assert.ok(section.includes('**Test**'));
  // Steers the agent toward file_read (skill-aware: no truncation, no line
  // numbers) instead of `exec cat`, which gets head+tail-previewed by
  // agent-runner and is then unrecoverable across session resumes.
  assert.ok(section.includes('file_read /skills/test/SKILL.md'));
  assert.ok(!section.includes('cat /skills/test/SKILL.md'));
});
