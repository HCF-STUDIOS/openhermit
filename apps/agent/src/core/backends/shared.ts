import { cp, mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';

import type { SyncSkillEntry } from '../exec-backend.js';

/**
 * Copy enabled skills into the host-side `<skillsRoot>/{system,user}/` layout,
 * removing stale entries within each subdir. Always walks both subdirs even
 * when one is empty, so uninstalling the last skill of a source actually
 * deletes its dir contents on disk.
 */
export const syncSkillsToHostDir = async (
  skillsRoot: string,
  skills: SyncSkillEntry[],
): Promise<void> => {
  const bySource = new Map<'system' | 'user', Map<string, string>>([
    ['system', new Map()],
    ['user', new Map()],
  ]);
  for (const s of skills) {
    bySource.get(s.source)!.set(s.id, s.sourcePath);
  }

  for (const [source, desired] of bySource) {
    const dir = path.join(skillsRoot, source);
    await mkdir(dir, { recursive: true });

    let existing: string[];
    try {
      existing = await readdir(dir);
    } catch {
      existing = [];
    }

    for (const name of existing) {
      if (!desired.has(name)) {
        await rm(path.join(dir, name), { recursive: true, force: true });
      }
    }

    for (const [id, sourcePath] of desired) {
      const destPath = path.join(dir, id);
      await rm(destPath, { recursive: true, force: true });
      await cp(sourcePath, destPath, { recursive: true });
    }
  }
};
