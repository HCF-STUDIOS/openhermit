import { isSandboxType } from '@openhermit/protocol';
import type { AgentStore, DbAgentConfigStore, SandboxStore } from '@openhermit/store';

/**
 * One-time migration: materialize each agent's legacy `config.exec.backends[]`
 * into `sandboxes` table rows, then strip `exec` from the config.
 *
 * Idempotent: skips agents that already have any sandbox row, so re-running
 * after a successful backfill is a no-op.
 */
export const backfillSandboxes = async (
  agentStore: AgentStore,
  configStore: DbAgentConfigStore,
  sandboxStore: SandboxStore,
  log: (msg: string) => void,
): Promise<void> => {
  const agents = await agentStore.list();
  let migrated = 0;
  for (const agent of agents) {
    const existing = await sandboxStore.listByAgent(agent.agentId);
    if (existing.length > 0) continue;

    const config = await configStore.getConfig(agent.agentId);
    const exec = config?.['exec'] as
      | { backends?: Array<Record<string, unknown>>; default_backend?: string }
      | undefined;
    const backends = exec?.backends ?? [];
    if (backends.length === 0) continue;

    const defaultId = exec?.default_backend ?? (backends[0]?.['id'] as string | undefined);
    const candidates = backends.map((backend) => ({
      backend,
      type: backend['type'],
      backendId: (backend['id'] as string | undefined) ?? backend['type'],
    }));
    const unsupported = candidates.find(({ type }) => !isSandboxType(type));
    if (unsupported) {
      log(`skipping sandbox backfill for agent ${agent.agentId}: unsupported type ${String(unsupported.type)}`);
      continue;
    }
    const validated = candidates.filter(
      (candidate): candidate is typeof candidate & { type: import('@openhermit/protocol').SandboxType; backendId: string } =>
        isSandboxType(candidate.type) && typeof candidate.backendId === 'string',
    );
    if (defaultId !== undefined && !validated.some(({ backendId }) => backendId === defaultId)) {
      log(`skipping sandbox backfill for agent ${agent.agentId}: default backend ${defaultId} was not found`);
      continue;
    }

    let migratedBackends = 0;
    for (const { backend, type, backendId } of validated) {
      const isDefault = defaultId === undefined ? backend === backends[0] : backendId === defaultId;
      const alias = isDefault ? 'default' : backendId;

      // Strip alias-meta keys from the per-row config snapshot — type and
      // alias are top-level columns. Keep everything else.
      const { type: _t, id: _i, ...rest } = backend;
      void _t;
      void _i;

      await sandboxStore.create({
        agentId: agent.agentId,
        alias,
        type,
        config: rest,
      });
      migratedBackends += 1;
    }

    if (config) {
      const { exec: _exec, ...remaining } = config;
      void _exec;
      await configStore.setConfig(agent.agentId, remaining);
    }
    migrated += 1;
    log(`backfilled ${migratedBackends} sandbox row(s) for agent ${agent.agentId}`);
  }
  if (migrated > 0) {
    log(`sandbox backfill complete: migrated ${migrated} agent(s)`);
  }
};
