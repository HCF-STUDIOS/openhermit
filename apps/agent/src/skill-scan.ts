/**
 * Filesystem-driven user-skill scan & restore.
 *
 * User skills are owned by the agent, not the platform: the agent creates and
 * edits them directly with the file tools under
 * `<agentHome>/.openhermit/skills/user/<slug>/`. The gateway can't see a remote
 * sandbox's filesystem, so two jobs bridge that gap — both go through the
 * backend's `FileBackend` (list/read/write), never `exec`:
 *
 *   scan    — walk the sandbox's user-skills dir, read each SKILL.md's
 *             frontmatter, back the folder up to blob storage, and reconcile the
 *             DB index (`skills` + `agent_skills`) so `loadSkillIndex` can inject
 *             the skill into the system prompt. The sandbox is the source of
 *             truth: a folder the agent deleted is removed from the index.
 *
 *   restore — on a fresh sandbox (no `.restored` marker) copy each backed-up
 *             user skill from blob back into the sandbox, but only where the
 *             folder is absent, so an agent's own edits/deletions on a persisted
 *             sandbox are never resurrected. Restore is additive and runs once
 *             per sandbox lifetime; scan then re-indexes whatever is on disk.
 */

import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  skillStorageId,
  parseSkillBlobPath,
  type SkillArtifactStore,
  type SkillRecord,
  type SkillStore,
} from '@openhermit/store';

import type { FileBackend } from './core/exec-backend.js';
import { parseFrontmatter } from './skills.js';

/** Cap on files per skill folder — a runaway skill dir shouldn't be packed. */
const MAX_SKILL_FILES = 64;
/** Cap on total bytes per skill folder. */
const MAX_SKILL_PAYLOAD_BYTES = 512 * 1024;
/** Folder-name shape enforced for indexed skills (folder basename === slug). */
const SKILL_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** Marker file that records restore already ran for this sandbox lifetime. */
const RESTORED_MARKER = '.restored';

export interface SkillScanContext {
  agentId: string;
  /** Path the agent's home appears at inside its exec env (POSIX). */
  agentHome: string;
  files: FileBackend;
  skillStore: SkillStore;
  artifactStore: SkillArtifactStore;
  log?: (msg: string) => void;
}

export interface SkillScanResult {
  /** Slugs with a readable, described SKILL.md found in the sandbox. */
  scanned: string[];
  /** Slugs written to (or refreshed in) the DB index. */
  upserted: string[];
  /** Slugs removed from the DB index because their folder is gone. */
  removed: string[];
  /** Folders skipped, with a reason (missing description, too big, bad name). */
  skipped: Array<{ slug: string; reason: string }>;
}

export interface SkillRestoreResult {
  /** True when the marker already existed and restore was a no-op. */
  alreadyDone: boolean;
  /** Slugs written back into the sandbox from blob. */
  restored: string[];
  /** Slugs skipped because the folder already existed on disk. */
  skipped: string[];
}

/** POSIX path of the agent's user-skills root inside the sandbox. */
const userSkillsRoot = (agentHome: string): string =>
  path.posix.join(agentHome.replace(/\/$/, ''), '.openhermit', 'skills', 'user');

/** All user skills the DB has recorded for this agent. */
const ownedUserSkills = async (
  skillStore: SkillStore,
  agentId: string,
): Promise<SkillRecord[]> =>
  (await skillStore.list()).filter(
    (s) => s.source === 'user' && s.ownerAgentId === agentId,
  );

/**
 * Recursively read every file under a sandbox directory via the FileBackend.
 * Returns POSIX-relative paths (relative to `root`) with their bytes. Hidden
 * entries (dotfiles/dirs) are skipped so markers never enter an archive.
 */
const collectSandboxFiles = async (
  files: FileBackend,
  root: string,
  rel = '',
): Promise<Array<{ rel: string; data: Buffer }>> => {
  const dir = rel ? path.posix.join(root, rel) : root;
  const entries = await files.list(dir);
  const out: Array<{ rel: string; data: Buffer }> = [];
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const childRel = rel ? path.posix.join(rel, e.name) : e.name;
    if (e.type === 'directory') {
      out.push(...(await collectSandboxFiles(files, root, childRel)));
    } else if (e.type === 'file') {
      const { data } = await files.read(path.posix.join(root, childRel));
      out.push({ rel: childRel, data });
    }
  }
  return out;
};

/** Materialize collected files into a fresh host dir so putSkill can pack it. */
const stageFiles = async (
  stageDir: string,
  collected: Array<{ rel: string; data: Buffer }>,
): Promise<void> => {
  for (const f of collected) {
    const dest = path.join(stageDir, f.rel);
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, f.data);
  }
};

/** Recursively list host files under `dir` as POSIX-relative paths. */
const walkHostDir = async (dir: string, rel = ''): Promise<string[]> => {
  const entries = await readdir(path.join(dir, rel), { withFileTypes: true });
  const out: string[] = [];
  for (const e of entries) {
    const childRel = rel ? path.posix.join(rel, e.name) : e.name;
    if (e.isDirectory()) out.push(...(await walkHostDir(dir, childRel)));
    else if (e.isFile()) out.push(childRel);
  }
  return out;
};

/**
 * Scan the sandbox's user-skills dir → back each folder up to blob → reconcile
 * the DB index. Idempotent: unchanged folders dedup by sha and re-upsert with
 * the same values; deleted folders drop out of the index.
 */
export const scanUserSkills = async (ctx: SkillScanContext): Promise<SkillScanResult> => {
  const { agentId, agentHome, files, skillStore, artifactStore } = ctx;
  const root = userSkillsRoot(agentHome);

  let dirents: Awaited<ReturnType<FileBackend['list']>>;
  try {
    dirents = await files.list(root);
  } catch {
    dirents = []; // Root doesn't exist yet — no user skills.
  }

  const result: SkillScanResult = { scanned: [], upserted: [], removed: [], skipped: [] };
  const seen = new Set<string>();

  for (const entry of dirents) {
    if (entry.type !== 'directory' || entry.name.startsWith('.')) continue;
    const slug = entry.name;
    if (!SKILL_ID_RE.test(slug)) {
      result.skipped.push({ slug, reason: 'invalid skill id' });
      continue;
    }
    const skillDir = path.posix.join(root, slug);

    let collected: Array<{ rel: string; data: Buffer }>;
    try {
      collected = await collectSandboxFiles(files, skillDir);
    } catch (err) {
      result.skipped.push({ slug, reason: `unreadable: ${err instanceof Error ? err.message : String(err)}` });
      continue;
    }

    const skillMd = collected.find((f) => f.rel === 'SKILL.md');
    if (!skillMd) {
      result.skipped.push({ slug, reason: 'no SKILL.md' });
      continue;
    }
    const fm = parseFrontmatter(skillMd.data.toString('utf8'));
    const name = fm.name || slug;
    const description = fm.description || '';
    if (!description) {
      result.skipped.push({ slug, reason: 'SKILL.md has no description' });
      continue;
    }
    if (collected.length > MAX_SKILL_FILES) {
      result.skipped.push({ slug, reason: `too many files (${collected.length} > ${MAX_SKILL_FILES})` });
      continue;
    }
    const totalBytes = collected.reduce((n, f) => n + f.data.length, 0);
    if (totalBytes > MAX_SKILL_PAYLOAD_BYTES) {
      result.skipped.push({ slug, reason: `too large (${totalBytes} > ${MAX_SKILL_PAYLOAD_BYTES} bytes)` });
      continue;
    }

    seen.add(slug);
    result.scanned.push(slug);

    const storageId = skillStorageId('user', slug, agentId);
    const existing = await skillStore.get(storageId);
    const priorSha256 =
      typeof existing?.metadata?.sha256 === 'string' ? (existing.metadata.sha256 as string) : undefined;

    // Back the folder up to blob (dedup by sha) via a short-lived stage dir.
    const stageDir = await mkdtemp(path.join(tmpdir(), 'oh-skill-scan-'));
    let put;
    try {
      await stageFiles(stageDir, collected);
      put = await artifactStore.putSkill(
        { source: 'user', slug, ownerAgentId: agentId },
        stageDir,
        priorSha256 ? { priorSha256 } : undefined,
      );
    } finally {
      await rm(stageDir, { recursive: true, force: true });
    }

    const now = new Date().toISOString();
    await skillStore.upsert({
      id: storageId,
      slug,
      name,
      description,
      path: put.path,
      source: 'user',
      ownerAgentId: agentId,
      metadata: { sha256: put.sha256, version: now },
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
    await skillStore.enable(agentId, storageId);
    result.upserted.push(slug);
  }

  // Reconcile deletions: a DB row whose folder is gone is removed from the
  // index and its archive dropped. The sandbox is the source of truth.
  for (const owned of await ownedUserSkills(skillStore, agentId)) {
    if (seen.has(owned.slug)) continue;
    await skillStore.disable(agentId, owned.id);
    await skillStore.delete(owned.id);
    const key = parseSkillBlobPath(owned.path);
    if (key) {
      try {
        await artifactStore.deleteArchive(key);
      } catch {
        // best-effort: a missing archive is fine.
      }
    }
    result.removed.push(owned.slug);
  }

  ctx.log?.(
    `[${agentId}] skill scan: ${result.scanned.length} found, ${result.upserted.length} indexed, ` +
      `${result.removed.length} removed, ${result.skipped.length} skipped`,
  );
  return result;
};

/**
 * Restore backed-up user skills into a fresh sandbox, once per lifetime. Gated
 * on a `.restored` marker so a persisted sandbox's own edits/deletions survive;
 * additive — an existing folder is never overwritten.
 */
export const restoreUserSkills = async (ctx: SkillScanContext): Promise<SkillRestoreResult> => {
  const { agentId, agentHome, files, skillStore, artifactStore } = ctx;
  const root = userSkillsRoot(agentHome);
  const marker = path.posix.join(root, RESTORED_MARKER);

  if (await files.stat(marker)) {
    return { alreadyDone: true, restored: [], skipped: [] };
  }

  const result: SkillRestoreResult = { alreadyDone: false, restored: [], skipped: [] };

  for (const owned of await ownedUserSkills(skillStore, agentId)) {
    const key = parseSkillBlobPath(owned.path);
    if (!key) continue; // legacy bare-path row — nothing to restore from blob.

    const skillDir = path.posix.join(root, owned.slug);
    if (await files.stat(path.posix.join(skillDir, 'SKILL.md'))) {
      result.skipped.push(owned.slug); // already present — never overwrite.
      continue;
    }

    const tempDir = await mkdtemp(path.join(tmpdir(), 'oh-skill-restore-'));
    try {
      await artifactStore.restoreTo(key, tempDir);
      for (const rel of await walkHostDir(tempDir)) {
        const data = await readFile(path.join(tempDir, rel));
        await files.write(path.posix.join(skillDir, rel), data, 'overwrite');
      }
      result.restored.push(owned.slug);
    } catch (err) {
      ctx.log?.(
        `[${agentId}] skill restore failed for "${owned.slug}": ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  // Drop the marker so subsequent boots on this sandbox skip restore.
  await files.write(
    marker,
    Buffer.from(`restored ${new Date().toISOString()}\n`, 'utf8'),
    'overwrite',
  );

  ctx.log?.(
    `[${agentId}] skill restore: ${result.restored.length} restored, ${result.skipped.length} already present`,
  );
  return result;
};
