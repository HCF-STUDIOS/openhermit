/**
 * Skill index loading: merges DB-enabled skills with workspace-scanned skills.
 */

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import type { SkillStore } from '@openhermit/store';

export interface SkillIndexEntry {
  id: string;
  name: string;
  description: string;
  /** Path the agent uses inside its exec env, e.g. `<agentHome>/.openhermit/skills/<id>`. */
  path: string;
  source: 'system' | 'workspace';
}

/** Parse YAML frontmatter from a SKILL.md file. */
export const parseFrontmatter = (content: string): Record<string, string> => {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};

  const result: Record<string, string> = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const sep = line.indexOf(':');
    if (sep <= 0) continue;
    const key = line.slice(0, sep).trim();
    const value = line.slice(sep + 1).trim();
    result[key] = value;
  }
  return result;
};

/**
 * Scan a directory for SKILL.md files and return index entries.
 * Expects: `baseDir/<skillId>/SKILL.md`
 */
export const scanSkillDirectory = async (
  baseDir: string,
  containerBasePath: string,
  source: 'system' | 'workspace',
  options: { exclude?: ReadonlySet<string> } = {},
): Promise<SkillIndexEntry[]> => {
  let entries: string[];
  try {
    entries = await readdir(baseDir, { withFileTypes: true }).then((dirents) =>
      dirents
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .filter((name) => !options.exclude?.has(name)),
    );
  } catch {
    return []; // Directory doesn't exist — no skills here.
  }

  const skills: SkillIndexEntry[] = [];
  for (const dirName of entries) {
    const skillMdPath = path.join(baseDir, dirName, 'SKILL.md');
    try {
      const content = await readFile(skillMdPath, 'utf8');
      const fm = parseFrontmatter(content);
      const name = fm.name || dirName;
      const description = fm.description || '';
      if (!description) continue; // Skip skills without a description.
      skills.push({
        id: dirName,
        name,
        description,
        path: `${containerBasePath}/${dirName}`,
        source,
      });
    } catch {
      // SKILL.md not readable — skip.
    }
  }
  return skills;
};

/**
 * Load the effective skill index for an agent. Both layers live under the
 * workspace's `.openhermit/skills/` directory:
 * - System skills (DB-managed, copied into `skills/system/<id>`)
 * - Workspace skills (user-installed, in `skills/<id>` excluding `system/`)
 *
 * Workspace skills win on id conflicts.
 */
export const loadSkillIndex = async (
  agentId: string,
  workspaceRoot: string,
  skillStore?: SkillStore,
  /** Path the agent's workspace appears at inside its exec env. Defaults to the host workspace path (host backend). */
  agentHome?: string,
): Promise<SkillIndexEntry[]> => {
  const entries = new Map<string, SkillIndexEntry>();
  const home = agentHome ?? workspaceRoot;

  // 1. DB-enabled (system) skills — synced into <workspace>/.openhermit/skills/system/
  if (skillStore) {
    const dbSkills = await skillStore.listEnabled(agentId);
    for (const skill of dbSkills) {
      entries.set(skill.id, {
        id: skill.id,
        name: skill.name,
        description: skill.description,
        path: `${home}/.openhermit/skills/system/${skill.id}`,
        source: 'system',
      });
    }
  }

  // 2. Workspace skills — overwrite system entries on id conflict.
  const workspaceSkillsDir = path.join(workspaceRoot, '.openhermit', 'skills');
  const wsSkills = await scanSkillDirectory(
    workspaceSkillsDir,
    `${home}/.openhermit/skills`,
    'workspace',
    { exclude: new Set(['system']) },
  );
  for (const skill of wsSkills) {
    entries.set(skill.id, skill);
  }

  return [...entries.values()].sort((a, b) => a.name.localeCompare(b.name));
};

/**
 * Format the skill index as a system prompt section.
 * Returns undefined if no skills are available.
 */
export const formatSkillsPromptSection = (skills: SkillIndexEntry[]): string | undefined => {
  if (skills.length === 0) return undefined;

  const lines = skills.map(
    (s) => `- **${s.name}**: ${s.description} — \`file_read ${s.path}/SKILL.md\``,
  );

  return `## Skills

The following skills provide specialized instructions for specific tasks. When a task matches a skill's description, read its SKILL.md in full with \`file_read\` (do not use \`exec cat\`; \`file_read\` returns skill files verbatim and uncapped).

${lines.join('\n')}`;
};
