import { stat } from 'node:fs/promises';

import { isSkillBlobPath } from '@openhermit/store';
import type { DbSkillStore, SkillArtifactStore } from '@openhermit/store';

export interface SkillMigrateSummary {
  id: string;
  slug: string;
  source: string;
  path: string;
}

export interface SkillMigrateResult {
  apply: boolean;
  totals: {
    total: number;
    alreadyBlob: number;
    wouldMigrate: number;
    missingFile: number;
    migrated: number;
    errors: number;
  };
  wouldMigrate: SkillMigrateSummary[];
  missingFile: SkillMigrateSummary[];
  migrated: Array<{ id: string; slug: string; blobPath: string; sizeBytes: number; skipped: boolean }>;
  errors: Array<{ id: string; error: string }>;
}

/**
 * Pack legacy bare-path skill directories from the local volume into blob
 * storage and flip `skills.path` to a `blob:` pointer, so the volume can be
 * dropped.
 *
 * Migration rule: migrate a row ONLY when its path is still legacy (not
 * `blob:`) AND the directory exists on this host. Any other row is left
 * untouched — a legacy path with no local file is not ours to migrate.
 *
 * Idempotent: already-migrated (`blob:`) rows are skipped, so this is safe to
 * run on every boot. Defaults to a read-only dry run; pass `apply: true` to
 * write. Shared by the admin endpoint and the startup auto-migrate.
 */
export const migrateSkillsToBlob = async (
  store: DbSkillStore,
  artifactStore: SkillArtifactStore,
  opts: { apply: boolean },
): Promise<SkillMigrateResult> => {
  const apply = opts.apply === true;
  const skills = await store.list();

  const wouldMigrate: SkillMigrateSummary[] = [];
  const missingFile: SkillMigrateSummary[] = [];
  const migrated: SkillMigrateResult['migrated'] = [];
  const errors: SkillMigrateResult['errors'] = [];
  let alreadyBlob = 0;

  for (const skill of skills) {
    if (isSkillBlobPath(skill.path)) {
      alreadyBlob++;
      continue;
    }
    // Legacy bare path — does the directory actually exist on this volume?
    let dirExists = false;
    try {
      const st = await stat(skill.path);
      dirExists = st.isDirectory();
    } catch {
      dirExists = false;
    }
    const summary: SkillMigrateSummary = {
      id: skill.id,
      slug: skill.slug,
      source: skill.source,
      path: skill.path,
    };
    if (!dirExists) {
      // Legacy path but no local file → not ours to migrate; leave untouched.
      missingFile.push(summary);
      continue;
    }
    wouldMigrate.push(summary);
    if (!apply) continue;

    try {
      const ref =
        skill.source === 'user'
          ? { source: 'user' as const, slug: skill.slug, ownerAgentId: skill.ownerAgentId ?? '' }
          : { source: 'system' as const, slug: skill.slug };
      const priorSha256 =
        typeof skill.metadata?.sha256 === 'string' ? (skill.metadata.sha256 as string) : undefined;
      const put = await artifactStore.putSkill(
        ref,
        skill.path,
        priorSha256 ? { priorSha256 } : undefined,
      );
      const now = new Date().toISOString();
      await store.upsert({
        ...skill,
        path: put.path,
        metadata: { ...(skill.metadata ?? {}), sha256: put.sha256, version: now },
        updatedAt: now,
      });
      migrated.push({
        id: skill.id,
        slug: skill.slug,
        blobPath: put.path,
        sizeBytes: put.sizeBytes,
        skipped: put.skipped,
      });
    } catch (error) {
      errors.push({ id: skill.id, error: error instanceof Error ? error.message : String(error) });
    }
  }

  return {
    apply,
    totals: {
      total: skills.length,
      alreadyBlob,
      wouldMigrate: wouldMigrate.length,
      missingFile: missingFile.length,
      migrated: migrated.length,
      errors: errors.length,
    },
    wouldMigrate,
    missingFile,
    migrated,
    errors,
  };
};
