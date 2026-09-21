import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { parseSkillBlobPath } from '@openhermit/store';

/**
 * The slice of `SkillArtifactStore` this helper needs — narrowed so tests can
 * pass a fake without standing up real blob storage.
 */
export interface SkillArchiveReader {
  restoreTo(storageKey: string, destDir: string): Promise<void>;
}

/**
 * Read a skill's `SKILL.md` from wherever the row's `path` points.
 *
 * A migrated skill's `path` is a `blob:` pointer with no local file, so the
 * archive is materialized into a temp dir and read from there, then dropped. A
 * legacy bare path is read straight off disk. Returns null when the source
 * cannot be read — missing on disk, an unrestorable blob, or a `blob:` row with
 * no artifact store configured — which the caller reports as `missing_on_disk`.
 */
export const readSkillMd = async (
  skillPath: string,
  artifactStore: SkillArchiveReader | undefined,
): Promise<string | null> => {
  const storageKey = parseSkillBlobPath(skillPath);
  if (storageKey === null) {
    return readFile(path.join(skillPath, 'SKILL.md'), 'utf8').catch(() => null);
  }
  if (!artifactStore) return null;
  const dir = await mkdtemp(path.join(tmpdir(), 'oh-skill-sync-'));
  try {
    await artifactStore.restoreTo(storageKey, dir);
    return await readFile(path.join(dir, 'SKILL.md'), 'utf8');
  } catch {
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};
