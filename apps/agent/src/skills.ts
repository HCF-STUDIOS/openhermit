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

/**
 * Classify an absolute path as living under the agent's skills directory.
 *
 * Skill files live at `<agentHome>/.openhermit/skills/`. Two downstream
 * policies key off this: `file_read` returns skill content verbatim
 * (no line numbers, no internal byte cap), and agent-runner skips the
 * head+tail preview that would otherwise corrupt skill content across
 * session resumes.
 *
 * Anchored to `agentHome` rather than substring-matched, so unrelated
 * trees that happen to contain `.openhermit/skills/` don't silently
 * inherit the bypass. `..` segments are rejected — paths flow through
 * here without further sanitization, so traversal must be neutralized.
 */
export const isSkillPath = (filePath: string, agentHome: string): boolean => {
  if (!path.posix.isAbsolute(filePath)) return false;
  const normalized = path.posix.normalize(filePath);
  if (normalized.split('/').includes('..')) return false;
  const skillsRoot = `${agentHome.replace(/\/$/, '')}/.openhermit/skills/`;
  return normalized.startsWith(skillsRoot);
};

/**
 * Decide — from a tool-execution-end event — whether a result represents
 * a skill-file read that should bypass agent-runner's head+tail preview.
 *
 * Owned entirely by the runner side: classifies by the dispatched tool
 * name (which the runner controls) plus the path the tool reports it
 * read, re-checked against the agent's skills root. The tool's return
 * value does not get to declare itself a skill read — only `file_read`
 * is authorized, and only for paths that pass `isSkillPath`.
 */
export const isSkillReadResult = (
  toolName: string,
  details: unknown,
  agentHome: string | undefined,
): boolean => {
  if (toolName !== 'file_read') return false;
  if (!agentHome) return false;
  if (typeof details !== 'object' || details === null) return false;
  const filePath = (details as { path?: unknown }).path;
  if (typeof filePath !== 'string') return false;
  return isSkillPath(filePath, agentHome);
};

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

  const escapeXml = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const entries = skills
    .map(
      (s) =>
        `  <skill>
    <name>${escapeXml(s.name)}</name>
    <description>${escapeXml(s.description)}</description>
    <location>${s.path}/SKILL.md</location>
  </skill>`,
    )
    .join('\n');

  return `## Skills

The following skills provide specialized instructions for specific tasks. Before replying, scan the <description> entries below. When one clearly matches the task, read its SKILL.md in full with \`file_read <location>\`. You MUST use the exact <location> value from <available_skills> — never guess, fabricate, or hard-code a skill file path. Do not use \`exec cat\`; \`file_read\` returns skill files verbatim and uncapped.

<available_skills>
${entries}
</available_skills>`;
};
