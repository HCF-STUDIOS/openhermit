/**
 * Owner-only skill management tool.
 *
 * User skills are managed by the agent itself: it creates and edits files under
 * `<agentHome>/.openhermit/skills/user/<slug>/` with the ordinary file tools,
 * exactly like editing any other workspace file. The one thing the agent can't
 * do from inside the sandbox is make the platform aware of those skills — the
 * gateway can't see a remote sandbox's filesystem, so a freshly-authored skill
 * would never appear in the system-prompt index.
 *
 * `skill_scan` closes that gap: it walks the sandbox's user-skills dir, reads
 * each SKILL.md's frontmatter, backs the folder up to blob storage, and
 * reconciles the DB index so the skill shows up in the prompt. The sandbox is
 * the source of truth — a folder the agent deleted drops out of the index. It
 * also runs automatically when a sandbox starts, so manual invocation is only
 * needed to pick up changes mid-session.
 */

import { Type } from '@mariozechner/pi-ai';

import { asTextContent, formatJson, type PolicyAwareTool, type Toolset } from './shared.js';
import type { SkillScanResult } from '../skill-scan.js';

const SkillScanParams = Type.Object({});

export const createSkillScanTool = (
  scan: () => Promise<SkillScanResult>,
): PolicyAwareTool<typeof SkillScanParams> => ({
  policy: { defaultGrants: [{ type: 'role', value: 'owner' }] },
  name: 'skill_scan',
  label: 'Scan Skills',
  description:
    'Re-index your user skills. Scans .openhermit/skills/user/, reads each SKILL.md, backs the files up, and updates the skill list shown in your prompt. Run this after you create, edit, or delete a skill folder so the change takes effect. Restricted to the owner.',
  parameters: SkillScanParams,
  execute: async () => {
    const result = await scan();
    return {
      content: asTextContent(
        formatJson({
          indexed: result.upserted,
          removed: result.removed,
          skipped: result.skipped,
        }),
      ),
      details: { indexed: result.upserted.length, removed: result.removed.length },
    };
  },
});

export const createSkillManagementToolset = (scan: () => Promise<SkillScanResult>): Toolset => ({
  id: 'skill_management',
  description: 'Owner-only tool for re-indexing user skills.',
  tools: [createSkillScanTool(scan)],
});
