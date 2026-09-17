import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { NotFoundError, ValidationError } from '@openhermit/shared';
import {
  LocalAttachmentStorage,
  SkillArtifactStore,
  skillStorageId,
  type SkillRecord,
  type SkillStore,
} from '@openhermit/store';

import type { FileBackend, FileWriteMode, DirEntry, FileStat } from '../src/core/exec-backend.js';
import { scanUserSkills, restoreUserSkills } from '../src/skill-scan.js';

const AGENT = 'agent-1';
const HOME = '/home/user';
const ROOT = `${HOME}/.openhermit/skills/user`;

// ── In-memory FileBackend (models a sandbox filesystem) ───────────────────

class MemoryFileBackend implements FileBackend {
  readonly files = new Map<string, Buffer>();

  private norm(p: string): string {
    return path.posix.normalize(p);
  }

  async read(filePath: string) {
    const data = this.files.get(this.norm(filePath));
    if (!data) throw new NotFoundError(`File not found: ${filePath}`);
    return { data };
  }

  async write(filePath: string, data: Buffer, mode: FileWriteMode): Promise<void> {
    const p = this.norm(filePath);
    if (mode === 'create' && this.files.has(p)) {
      throw new ValidationError(`File already exists (mode=create): ${filePath}`);
    }
    if (mode === 'append') {
      this.files.set(p, Buffer.concat([this.files.get(p) ?? Buffer.alloc(0), data]));
    } else {
      this.files.set(p, data);
    }
  }

  async list(dirPath: string): Promise<DirEntry[]> {
    const dir = this.norm(dirPath);
    const prefix = dir.endsWith('/') ? dir : `${dir}/`;
    const byName = new Map<string, DirEntry>();
    let matched = false;
    for (const key of this.files.keys()) {
      if (!key.startsWith(prefix)) continue;
      matched = true;
      const rest = key.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash === -1) {
        byName.set(rest, { name: rest, type: 'file', size: this.files.get(key)!.length });
      } else {
        const name = rest.slice(0, slash);
        byName.set(name, { name, type: 'directory' });
      }
    }
    if (!matched) throw new NotFoundError(`Directory not found: ${dirPath}`);
    return [...byName.values()];
  }

  async stat(filePath: string): Promise<FileStat | null> {
    const p = this.norm(filePath);
    const file = this.files.get(p);
    if (file) return { type: 'file', size: file.length, mtime: '1970-01-01T00:00:00.000Z' };
    const prefix = `${p}/`;
    for (const key of this.files.keys()) {
      if (key.startsWith(prefix)) return { type: 'directory', size: 0, mtime: '1970-01-01T00:00:00.000Z' };
    }
    return null;
  }

  async delete(filePath: string): Promise<void> {
    this.files.delete(this.norm(filePath));
  }
}

// ── In-memory SkillStore ──────────────────────────────────────────────────

class FakeSkillStore implements SkillStore {
  readonly skills = new Map<string, SkillRecord>();
  private readonly assignments = new Set<string>();

  async upsert(skill: SkillRecord): Promise<void> {
    this.skills.set(skill.id, skill);
  }
  async get(id: string): Promise<SkillRecord | undefined> {
    return this.skills.get(id);
  }
  async list(): Promise<SkillRecord[]> {
    return [...this.skills.values()];
  }
  async delete(id: string): Promise<void> {
    this.skills.delete(id);
    for (const key of [...this.assignments]) {
      if (key.endsWith(`::${id}`)) this.assignments.delete(key);
    }
  }
  async enable(agentId: string, skillId: string): Promise<void> {
    this.assignments.add(`${agentId}::${skillId}`);
  }
  async disable(agentId: string, skillId: string): Promise<void> {
    this.assignments.delete(`${agentId}::${skillId}`);
  }
  async listEnabled(agentId: string): Promise<SkillRecord[]> {
    return [...this.skills.values()].filter(
      (s) => this.assignments.has(`${agentId}::${s.id}`) || this.assignments.has(`*::${s.id}`),
    );
  }
  async listAssignments() {
    return [];
  }
  isEnabled(agentId: string, skillId: string): boolean {
    return this.assignments.has(`${agentId}::${skillId}`);
  }
}

const makeCtx = async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'oh-scan-blob-'));
  const files = new MemoryFileBackend();
  const skillStore = new FakeSkillStore();
  const artifactStore = new SkillArtifactStore(new LocalAttachmentStorage({ root }));
  const ctx = { agentId: AGENT, agentHome: HOME, files, skillStore, artifactStore };
  return { root, files, skillStore, artifactStore, ctx };
};

const put = (files: MemoryFileBackend, rel: string, body: string) =>
  files.files.set(`${ROOT}/${rel}`, Buffer.from(body, 'utf8'));

const SKILL_MD = '---\nname: Weather\ndescription: Look up the weather.\n---\n\nDo the thing.\n';

// ── scan ───────────────────────────────────────────────────────────────────

test('scan indexes a described skill folder and backs it up to blob', async () => {
  const { root, files, skillStore, ctx } = await makeCtx();
  try {
    put(files, 'weather/SKILL.md', SKILL_MD);
    put(files, 'weather/scripts/run.sh', '#!/bin/sh\necho hi\n');

    const result = await scanUserSkills(ctx);
    assert.deepEqual(result.scanned, ['weather']);
    assert.deepEqual(result.upserted, ['weather']);

    const id = skillStorageId('user', 'weather', AGENT);
    const row = skillStore.skills.get(id);
    assert.ok(row, 'row upserted');
    assert.equal(row!.slug, 'weather');
    assert.equal(row!.name, 'Weather');
    assert.equal(row!.description, 'Look up the weather.');
    assert.equal(row!.source, 'user');
    assert.equal(row!.ownerAgentId, AGENT);
    assert.match(row!.path, /^blob:skills\/user\//);
    assert.ok(skillStore.isEnabled(AGENT, id), 'enabled for the agent');

    // Archive is restorable and content-complete.
    const dest = await mkdtemp(path.join(tmpdir(), 'oh-verify-'));
    try {
      const key = row!.path.replace(/^blob:/, '');
      await ctx.artifactStore.restoreTo(key, dest);
      const { readFile } = await import('node:fs/promises');
      assert.equal(await readFile(path.join(dest, 'SKILL.md'), 'utf8'), SKILL_MD);
      assert.equal(await readFile(path.join(dest, 'scripts', 'run.sh'), 'utf8'), '#!/bin/sh\necho hi\n');
    } finally {
      await rm(dest, { recursive: true, force: true });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('scan skips a folder whose SKILL.md has no description', async () => {
  const { root, files, skillStore, ctx } = await makeCtx();
  try {
    put(files, 'nodesc/SKILL.md', '---\nname: NoDesc\n---\nbody\n');
    const result = await scanUserSkills(ctx);
    assert.deepEqual(result.scanned, []);
    assert.equal(result.skipped.length, 1);
    assert.equal(result.skipped[0]!.slug, 'nodesc');
    assert.equal(skillStore.skills.size, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('scan removes a skill from the index when its folder is gone (sandbox is truth)', async () => {
  const { root, files, skillStore, artifactStore, ctx } = await makeCtx();
  try {
    put(files, 'weather/SKILL.md', SKILL_MD);
    await scanUserSkills(ctx);
    const id = skillStorageId('user', 'weather', AGENT);
    assert.ok(skillStore.skills.has(id));

    // Agent deletes the folder, then a rescan.
    files.files.delete(`${ROOT}/weather/SKILL.md`);
    const result = await scanUserSkills(ctx);
    assert.deepEqual(result.removed, ['weather']);
    assert.equal(skillStore.skills.has(id), false, 'row deleted');
    assert.ok(!skillStore.isEnabled(AGENT, id), 'assignment cleared');

    // Archive removed too.
    await assert.rejects(artifactStore.getArchive('skills/user/' + AGENT + '/weather.tar.gz'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('scan on an empty/absent user dir is a no-op', async () => {
  const { root, ctx } = await makeCtx();
  try {
    const result = await scanUserSkills(ctx);
    assert.deepEqual(result, { scanned: [], upserted: [], removed: [], skipped: [] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ── restore ─────────────────────────────────────────────────────────────────

test('restore writes backed-up skills into a fresh sandbox, then marks itself done', async () => {
  const { root, files, skillStore, artifactStore, ctx } = await makeCtx();
  try {
    // Seed blob + DB as a prior scan would have, with an empty sandbox.
    put(files, 'weather/SKILL.md', SKILL_MD);
    await scanUserSkills(ctx);
    for (const key of [...files.files.keys()]) files.files.delete(key); // fresh sandbox

    const first = await restoreUserSkills(ctx);
    assert.equal(first.alreadyDone, false);
    assert.deepEqual(first.restored, ['weather']);
    assert.equal(
      files.files.get(`${ROOT}/weather/SKILL.md`)?.toString('utf8'),
      SKILL_MD,
      'SKILL.md written back into the sandbox',
    );
    assert.ok(await files.stat(`${ROOT}/.restored`), 'marker dropped');

    // Second call is a no-op (marker present).
    const second = await restoreUserSkills(ctx);
    assert.equal(second.alreadyDone, true);
    assert.deepEqual(second.restored, []);

    void skillStore;
    void artifactStore;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('restore never overwrites a folder the agent already has', async () => {
  const { root, files, ctx } = await makeCtx();
  try {
    put(files, 'weather/SKILL.md', SKILL_MD);
    await scanUserSkills(ctx);

    // Agent edits the skill locally; wipe the marker to force a restore attempt.
    put(files, 'weather/SKILL.md', '---\nname: Weather\ndescription: EDITED.\n---\nlocal edit\n');

    const result = await restoreUserSkills(ctx);
    assert.deepEqual(result.restored, []);
    assert.deepEqual(result.skipped, ['weather']);
    assert.match(
      files.files.get(`${ROOT}/weather/SKILL.md`)!.toString('utf8'),
      /EDITED/,
      'local edit preserved — not clobbered by the blob copy',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
