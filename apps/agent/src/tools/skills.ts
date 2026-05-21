/**
 * Owner-only skill management tools.
 *
 * Skill source files are owned by the gateway host (the platform), not by
 * the sandbox. `skill_install` writes user-skill files into a gateway-host
 * directory and upserts a DB row (source='user', ownerAgentId=agentId), then
 * triggers a resync so every backend lands the new files at
 * `<agentHome>/.openhermit/skills/user/<id>/`. `skill_uninstall` does the
 * inverse and is gated on ownerAgentId so an owner cannot uninstall a peer's
 * skill or a system skill by guessing the id.
 *
 * Direct sandbox-side writes into `skills/user/` are deliberately avoided —
 * for remote backends (e2b/daytona) those would be invisible to the platform
 * and would drift on the next reset.
 */

import path from 'node:path';
import { mkdir, rm, writeFile } from 'node:fs/promises';

import { Type, type Static } from '@mariozechner/pi-ai';
import { resolveAgentDataDir, ValidationError } from '@openhermit/shared';
import { skillStorageId, type SkillStore } from '@openhermit/store';

import { asTextContent, formatJson, type PolicyAwareTool, type Toolset } from './shared.js';

/** Absolute byte cap on a single skill payload (SKILL.md + supporting files). */
const MAX_SKILL_PAYLOAD_BYTES = 256 * 1024;
const MAX_SKILL_FILES = 32;
const SKILL_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SUPPORT_PATH_RE = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/;

const SkillInstallParams = Type.Object({
  id: Type.String({
    description:
      'Folder-safe skill id (lowercase letters, digits, hyphens; 1–64 chars). Becomes the basename of the synced skill directory.',
  }),
  name: Type.String({ description: 'Human-readable skill name shown in the prompt index.' }),
  description: Type.String({
    description: 'One-line summary; agents see this when deciding whether to read SKILL.md.',
  }),
  markdown: Type.String({
    description:
      'Full SKILL.md contents. Should begin with `---\\nname: ...\\ndescription: ...\\n---` frontmatter.',
  }),
  files: Type.Optional(
    Type.Array(
      Type.Object({
        path: Type.String({
          description:
            'Relative path inside the skill folder. Must not contain `..`, leading `/`, or backslashes.',
        }),
        content: Type.String({ description: 'UTF-8 file contents.' }),
      }),
      {
        description: 'Optional supporting files placed alongside SKILL.md.',
      },
    ),
  ),
});

const SkillUninstallParams = Type.Object({
  id: Type.String({ description: 'The skill id to uninstall. Must be a user skill you installed.' }),
});

const userSkillSourceDir = (agentId: string, skillId: string): string =>
  path.join(resolveAgentDataDir(agentId), 'skills', 'user', skillId);

const validateSkillId = (id: string): void => {
  if (!SKILL_ID_RE.test(id)) {
    throw new ValidationError(
      `Invalid skill id "${id}". Use 1–64 chars of [a-z0-9-], starting with a letter or digit.`,
    );
  }
};

const validateSupportPath = (rel: string): void => {
  if (rel === 'SKILL.md') {
    throw new ValidationError(
      'Do not include SKILL.md in `files` — use the `markdown` parameter instead.',
    );
  }
  if (!SUPPORT_PATH_RE.test(rel)) {
    throw new ValidationError(
      `Invalid supporting file path "${rel}". Must be a relative POSIX path of safe characters with no .. segments.`,
    );
  }
};

export const createSkillInstallTool = (
  skillStore: SkillStore,
  agentId: string,
  resyncSkills: () => Promise<void>,
): PolicyAwareTool<typeof SkillInstallParams> => ({
  policy: { defaultGrants: [{ type: 'role', value: 'owner' }] },
  name: 'skill_install',
  label: 'Install Skill',
  description:
    'Install a user-scoped skill for this agent. The skill files are stored on the platform host and synced into the sandbox under .openhermit/skills/user/<id>/. Restricted to the owner.',
  parameters: SkillInstallParams,
  execute: async (_toolCallId, args: Static<typeof SkillInstallParams>) => {
    validateSkillId(args.id);

    const files = args.files ?? [];
    if (files.length > MAX_SKILL_FILES) {
      throw new ValidationError(
        `Too many supporting files (${files.length}); cap is ${MAX_SKILL_FILES}.`,
      );
    }
    let totalBytes = Buffer.byteLength(args.markdown, 'utf8');
    for (const f of files) {
      validateSupportPath(f.path);
      totalBytes += Buffer.byteLength(f.content, 'utf8');
    }
    if (totalBytes > MAX_SKILL_PAYLOAD_BYTES) {
      throw new ValidationError(
        `Skill payload is ${totalBytes} bytes; cap is ${MAX_SKILL_PAYLOAD_BYTES}.`,
      );
    }

    // Refuse to shadow a system skill with the same slug. User skills are
    // already scoped per-owner by the storage id, so two agents can install
    // a user skill named "foo" without colliding — but a user-skill "foo"
    // alongside a system-skill "foo" would confuse the prompt index.
    const storageId = skillStorageId('user', args.id, agentId);
    const existing = await skillStore.get(storageId);
    const systemConflict = await skillStore.get(args.id);
    if (systemConflict && systemConflict.source === 'system') {
      throw new ValidationError(
        `Skill "${args.id}" is already in use by a system skill. Choose a different id.`,
      );
    }

    const sourceDir = userSkillSourceDir(agentId, args.id);
    await rm(sourceDir, { recursive: true, force: true });
    await mkdir(sourceDir, { recursive: true });
    await writeFile(path.join(sourceDir, 'SKILL.md'), args.markdown, 'utf8');
    for (const f of files) {
      const destPath = path.join(sourceDir, f.path);
      await mkdir(path.dirname(destPath), { recursive: true });
      await writeFile(destPath, f.content, 'utf8');
    }

    const now = new Date().toISOString();
    await skillStore.upsert({
      id: storageId,
      slug: args.id,
      name: args.name,
      description: args.description,
      path: sourceDir,
      source: 'user',
      ownerAgentId: agentId,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
    await skillStore.enable(agentId, storageId);

    await resyncSkills();

    return {
      content: asTextContent(
        formatJson({
          id: args.id,
          name: args.name,
          source: 'user',
          fileCount: 1 + files.length,
          totalBytes,
          installed: true,
        }),
      ),
      details: { skillId: args.id },
    };
  },
});

export const createSkillUninstallTool = (
  skillStore: SkillStore,
  agentId: string,
  resyncSkills: () => Promise<void>,
): PolicyAwareTool<typeof SkillUninstallParams> => ({
  policy: { defaultGrants: [{ type: 'role', value: 'owner' }] },
  name: 'skill_uninstall',
  label: 'Uninstall Skill',
  description:
    'Uninstall a previously-installed user skill. Only skills you (the owner of this agent) installed can be removed; system skills are managed by the platform.',
  parameters: SkillUninstallParams,
  execute: async (_toolCallId, args: Static<typeof SkillUninstallParams>) => {
    validateSkillId(args.id);
    const storageId = skillStorageId('user', args.id, agentId);
    const existing = await skillStore.get(storageId);
    if (!existing || existing.source !== 'user' || existing.ownerAgentId !== agentId) {
      throw new ValidationError(
        `Skill "${args.id}" is not a user skill installed by this agent and cannot be removed via skill_uninstall.`,
      );
    }

    await skillStore.disable(agentId, storageId);
    await skillStore.delete(storageId);
    await rm(userSkillSourceDir(agentId, args.id), { recursive: true, force: true });

    await resyncSkills();

    return {
      content: asTextContent(formatJson({ id: args.id, removed: true })),
      details: { skillId: args.id },
    };
  },
});

export const createSkillManagementToolset = (
  skillStore: SkillStore,
  agentId: string,
  resyncSkills: () => Promise<void>,
): Toolset => ({
  id: 'skill_management',
  description: 'Owner-only tools for installing and removing user skills.',
  tools: [
    createSkillInstallTool(skillStore, agentId, resyncSkills),
    createSkillUninstallTool(skillStore, agentId, resyncSkills),
  ],
});
