import { access, mkdir, readFile, rm, cp, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';

import type { SyncSkillEntry } from '../exec-backend.js';

export type SkillSource = 'system' | 'user';

const SKILL_SOURCES: readonly SkillSource[] = ['system', 'user'];

/**
 * Basename of the manifest openhermit writes next to `system/` and `user/`.
 *
 * It records exactly which skill directories this sync created, so the next
 * sync can delete the ones that went away without touching anything else that
 * happens to live under `skills/`. Agents do create directories there by hand
 * (a scratch skill, a work-in-progress SKILL.md), and before the manifest
 * existed every sync wiped both subdirs wholesale and took that work with it.
 */
export const SKILL_MANIFEST_BASENAME = '.openhermit-skills.json';

interface SkillManifest {
  version: 1;
  managed: Record<SkillSource, string[]>;
  updatedAt: string;
}

export type ManagedSkillIds = Record<SkillSource, string[]>;

const emptyManaged = (): ManagedSkillIds => ({ system: [], user: [] });

/**
 * Read the managed-id sets out of a manifest body. Anything unreadable —
 * missing file, truncated write, a manifest from a future version — degrades
 * to "nothing is managed", which prunes nothing. Erring that way loses a stale
 * skill directory; erring the other way loses the agent's files.
 */
export const parseSkillManifest = (raw: string | null | undefined): ManagedSkillIds => {
  if (!raw?.trim()) return emptyManaged();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyManaged();
  }
  const managed = (parsed as Partial<SkillManifest> | null)?.managed;
  if (!managed || typeof managed !== 'object') return emptyManaged();
  const out = emptyManaged();
  for (const source of SKILL_SOURCES) {
    const ids = (managed as Record<string, unknown>)[source];
    if (Array.isArray(ids)) {
      out[source] = ids.filter((id): id is string => typeof id === 'string' && id.length > 0);
    }
  }
  return out;
};

export interface SkillSyncPlan {
  /** Directories to delete: previously synced skills that are no longer desired. */
  prune: Array<{ source: SkillSource; id: string }>;
  /** Skills to (re)upload, deduplicated by source+id. */
  install: SyncSkillEntry[];
  /** Manifest body to persist once the install lands. */
  manifest: string;
}

/**
 * Diff the desired skill set against the previously managed one.
 *
 * `previous` comes from the manifest, so a directory openhermit never synced is
 * absent from both sides of the diff and is left alone.
 */
export const planSkillSync = (
  skills: SyncSkillEntry[],
  previous: ManagedSkillIds,
): SkillSyncPlan => {
  const desired = new Map<SkillSource, Map<string, SyncSkillEntry>>(
    SKILL_SOURCES.map((source) => [source, new Map<string, SyncSkillEntry>()]),
  );
  for (const skill of skills) {
    desired.get(skill.source)?.set(skill.id, skill);
  }

  const prune: SkillSyncPlan['prune'] = [];
  for (const source of SKILL_SOURCES) {
    const keep = desired.get(source)!;
    for (const id of previous[source] ?? []) {
      if (!keep.has(id)) prune.push({ source, id });
    }
  }

  const install: SyncSkillEntry[] = [];
  for (const source of SKILL_SOURCES) {
    for (const skill of desired.get(source)!.values()) install.push(skill);
  }

  const manifest: SkillManifest = {
    version: 1,
    managed: {
      system: [...desired.get('system')!.keys()].sort(),
      user: [...desired.get('user')!.keys()].sort(),
    },
    updatedAt: new Date().toISOString(),
  };

  return { prune, install, manifest: `${JSON.stringify(manifest, null, 2)}\n` };
};

// ── Host-side sync (host / docker backends) ──────────────────────────────

/**
 * Copy enabled skills into the host-side `<skillsRoot>/{system,user}/` layout,
 * removing the skill directories a previous sync created that are no longer
 * enabled. Directories openhermit did not create are left in place.
 */
export const syncSkillsToHostDir = async (
  skillsRoot: string,
  skills: SyncSkillEntry[],
): Promise<void> => {
  const manifestPath = path.join(skillsRoot, SKILL_MANIFEST_BASENAME);
  let raw: string | null = null;
  try {
    raw = await readFile(manifestPath, 'utf8');
  } catch {
    raw = null;
  }
  const plan = planSkillSync(skills, parseSkillManifest(raw));

  for (const source of SKILL_SOURCES) {
    await mkdir(path.join(skillsRoot, source), { recursive: true });
  }
  for (const { source, id } of plan.prune) {
    await rm(path.join(skillsRoot, source, id), { recursive: true, force: true });
  }
  for (const skill of plan.install) {
    const destPath = path.join(skillsRoot, skill.source, skill.id);
    await rm(destPath, { recursive: true, force: true });
    await cp(skill.sourcePath, destPath, { recursive: true });
  }
  await writeFile(manifestPath, plan.manifest, 'utf8');
};

// ── Remote sync (e2b / daytona / tenki backends) ─────────────────────────

const shQuote = (value: string): string => `'${value.split("'").join(`'\\''`)}'`;

const skillDirPath = (skillsRoot: string, source: SkillSource, id: string): string =>
  `${skillsRoot}/${source}/${id}`;

export const skillManifestPath = (skillsRoot: string): string =>
  `${skillsRoot}/${SKILL_MANIFEST_BASENAME}`;

/** `sh -c` body that prints the manifest, or nothing when it does not exist. */
export const buildSkillManifestReadScript = (skillsRoot: string): string =>
  `cat ${shQuote(skillManifestPath(skillsRoot))} 2>/dev/null || true`;

/**
 * `sh -c` body to run before uploading: create both subdirs, drop the skill
 * directories that are no longer enabled, and clear the ones about to be
 * re-uploaded so a shrinking skill does not keep its deleted files.
 */
export const buildSkillSyncPrepareScript = (
  skillsRoot: string,
  plan: SkillSyncPlan,
): string => {
  const lines = ['set -eu'];
  lines.push(
    `mkdir -p ${shQuote(`${skillsRoot}/system`)} ${shQuote(`${skillsRoot}/user`)}`,
  );
  for (const { source, id } of plan.prune) {
    lines.push(`rm -rf ${shQuote(skillDirPath(skillsRoot, source, id))}`);
  }
  for (const skill of plan.install) {
    lines.push(`rm -rf ${shQuote(skillDirPath(skillsRoot, skill.source, skill.id))}`);
  }
  return lines.join('\n');
};

/**
 * `sh -c` body to run after uploading. Writes the manifest, and — when the
 * upload went to a staging directory — swaps each staged skill into place
 * first, so a half-finished upload never replaces a working skill.
 */
export const buildSkillSyncCommitScript = (
  skillsRoot: string,
  plan: SkillSyncPlan,
  stageRoot?: string,
): string => {
  const lines = ['set -eu'];
  if (stageRoot) {
    lines.push(
      `mkdir -p ${shQuote(`${skillsRoot}/system`)} ${shQuote(`${skillsRoot}/user`)}`,
    );
    for (const { source, id } of plan.prune) {
      lines.push(`rm -rf ${shQuote(skillDirPath(skillsRoot, source, id))}`);
    }
    for (const skill of plan.install) {
      const target = skillDirPath(skillsRoot, skill.source, skill.id);
      lines.push(`rm -rf ${shQuote(target)}`);
      lines.push(
        `mv ${shQuote(skillDirPath(stageRoot, skill.source, skill.id))} ${shQuote(target)}`,
      );
    }
  }
  const encoded = Buffer.from(plan.manifest, 'utf8').toString('base64');
  lines.push(
    `printf %s ${shQuote(encoded)} | base64 -d > ${shQuote(skillManifestPath(skillsRoot))}`,
  );
  if (stageRoot) lines.push(`rm -rf ${shQuote(stageRoot)}`);
  return lines.join('\n');
};

/**
 * Fail before the destructive prepare script runs if any skill source is
 * unreadable. `syncSkills` materializes blob-backed skills into a temp stage
 * dir; if a stage dir vanished (a botched restore, a cleanup race), uploading
 * would skip that skill while the prepare script has already removed its old
 * copy — leaving the sandbox without a skill the agent still has enabled.
 * Refusing the whole sync keeps the last-good copy in place instead.
 */
export const assertSkillSourcesReadable = async (
  install: SyncSkillEntry[],
): Promise<void> => {
  const unreadable: string[] = [];
  await Promise.all(
    install.map(async (skill) => {
      try {
        await access(path.join(skill.sourcePath, 'SKILL.md'), fsConstants.R_OK);
      } catch {
        unreadable.push(`${skill.source}/${skill.id}`);
      }
    }),
  );
  if (unreadable.length > 0) {
    throw new Error(
      `skill sources are unreadable, refusing sync: ${unreadable.sort().join(', ')}`,
    );
  }
};

// ── Pending-sync dirty flag (e2b / daytona / tenki backends) ──────────────

/**
 * Runtime-state key holding a single boolean: does this sandbox have enabled
 * system skills that were changed while it was paused/cold and not yet synced?
 *
 * We deliberately store *only* a flag — not the skill list or any host path.
 * The list is re-derived from the database on the next ensure(), so a temp
 * staging path (long deleted by the time the sandbox wakes) never gets frozen
 * into runtime_state the way the old `<backend>_pending_skills` entries did.
 */
export const PENDING_SYNC_SKILLS_KEY = 'pending_sync_skills';

interface RuntimeStateAccess {
  getRuntimeState?: (() => Promise<Record<string, unknown> | null>) | undefined;
  setRuntimeState?: ((state: Record<string, unknown>) => Promise<void>) | undefined;
}

const readPendingSkillSyncFlag = async (
  getRuntimeState: RuntimeStateAccess['getRuntimeState'],
): Promise<boolean> => {
  if (!getRuntimeState) return false;
  const state = await getRuntimeState().catch(() => null);
  return state?.[PENDING_SYNC_SKILLS_KEY] === true;
};

/** Set or clear the dirty flag; a no-op when the backend has no runtime state. */
export const writePendingSkillSyncFlag = async (
  access: RuntimeStateAccess,
  dirty: boolean,
): Promise<void> => {
  if (!access.getRuntimeState || !access.setRuntimeState) return;
  const state = (await access.getRuntimeState().catch(() => null)) ?? {};
  if (dirty) {
    state[PENDING_SYNC_SKILLS_KEY] = true;
  } else {
    delete state[PENDING_SYNC_SKILLS_KEY];
  }
  await access.setRuntimeState(state);
};

/**
 * Bring a just-ensured sandbox's system skills in line with the database.
 *
 * A fresh sandbox always syncs (it starts empty). A resumed one syncs only
 * when the dirty flag says something changed while it slept — otherwise the
 * manifest already matches and we skip the round-trip. On success the flag is
 * cleared; failures are swallowed with a warning so ensure() still returns a
 * usable sandbox (the flag stays set, so the next ensure retries).
 */
export const reconcileSystemSkillsOnEnsure = async (params: {
  fresh: boolean;
  label: string;
  getRuntimeState?: (() => Promise<Record<string, unknown> | null>) | undefined;
  setRuntimeState?: ((state: Record<string, unknown>) => Promise<void>) | undefined;
  getEnabledSystemSkills?:
    | (() => Promise<{ skills: SyncSkillEntry[]; cleanup: () => Promise<void> }>)
    | undefined;
  apply: (skills: SyncSkillEntry[]) => Promise<void>;
}): Promise<void> => {
  const { fresh, label, getRuntimeState, setRuntimeState, getEnabledSystemSkills, apply } =
    params;
  // Without a resolver we cannot know the desired set; syncing an empty list
  // would prune every managed skill, so do nothing instead.
  if (!getEnabledSystemSkills) return;
  const dirty = await readPendingSkillSyncFlag(getRuntimeState);
  if (!fresh && !dirty) return;

  try {
    const { skills, cleanup } = await getEnabledSystemSkills();
    try {
      await apply(skills);
    } finally {
      await cleanup().catch(() => undefined);
    }
    await writePendingSkillSyncFlag({ getRuntimeState, setRuntimeState }, false);
  } catch (err) {
    console.warn(
      `[exec-backend][${label}] system skill reconcile failed; will retry on next ensure`,
      err,
    );
  }
};
