/**
 * Sync platform/user skills into a running agent's exec backends.
 *
 * Each backend (host/docker/e2b/daytona) writes into the `system/` or `user/`
 * subdir under `.openhermit/skills/` based on each row's `source` column.
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
    // storage id) so user-skill folders are named like the user-visible id.
    enabled.map((s) => ({ id: s.slug, sourcePath: s.path, source: s.source })),
  );
};
