/**
 * Push platform (system) skills into a running agent's exec backends.
 *
 * Only system skills are pushed here: they're platform-owned, so the gateway
 * copies them (overwrite) into each backend's `.openhermit/skills/system/`.
 * User skills are agent-owned and managed via the sandbox filesystem + the
 * scan/restore path (see AgentRunner.scanUserSkills/restoreUserSkills), so they
 * are deliberately excluded here — pushing them would clobber the agent's edits.
 */

import type { AgentRunner } from '@openhermit/agent/agent-runner';
import type { DbSkillStore } from '@openhermit/store';

export const syncSkillMounts = async (
  agentId: string,
  runner: AgentRunner,
  skillStore: DbSkillStore,
): Promise<void> => {
  const enabled = await skillStore.listEnabled(agentId);
  await runner.syncSkills(
    // SyncSkillEntry.id is the folder basename — use slug (not the encoded
    // storage id) so skill folders are named like the user-visible id.
    enabled
      .filter((s) => s.source === 'system')
      .map((s) => ({ id: s.slug, sourcePath: s.path, source: s.source })),
  );
};
