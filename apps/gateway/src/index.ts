import type { AddressInfo } from 'node:net';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stderr } from 'node:process';
import { LogBuffer } from './log-buffer.js';

import { createAdaptorServer } from '@hono/node-server';

import {
  DbAgentStore,
  DbInstructionStore,
  DbAgentConfigStore,
  DbMcpServerStore,
  DbSandboxStore,
  DbPolicyStore,
  DbApprovalRequestStore,
  DbScheduleStore,
  DbSkillStore,
  DbUserStore,
  FileSecretStore,
  DbSecretStore,
  DbAgentChannelStore,
  DbMetaStore,
  runMigrations,
} from '@openhermit/store';
import { scanSkillDirectory } from '@openhermit/agent/skills';

import {
  loadEnv,
  migrateLegacyGatewayLayout,
  resolveAgentDataDir,
  resolveGatewayDir,
  resolveOpenHermitHome,
} from '@openhermit/shared';

import { AgentInstanceManager } from './agent-instance.js';
import { CentralScheduler } from './central-scheduler.js';
import { syncSkillMounts } from './skill-mounts.js';
import { backfillSandboxes } from './sandbox-backfill.js';
import { createGatewayApp } from './app.js';
import { loadGatewayConfig } from './config.js';
import { attachGatewayWs } from './ws-handler.js';
import {
  type AuthResolverOptions,
  ChannelRegistry,
  DeviceKeyAuthProvider,
  createJwtConfig,
} from './auth.js';

const DEFAULT_CONFIG_FILENAME = 'gateway.json';

type NodeFetchCallback = Parameters<typeof createAdaptorServer>[0]['fetch'];

const logBuffer = new LogBuffer();
const logStartup = logBuffer.wrap((message: string): void => {
  console.log(`[openhermit-gateway] ${message}`);
});


const listen = (
  fetch: NodeFetchCallback,
  port: number,
  host: string,
): Promise<{ server: ReturnType<typeof createAdaptorServer>; info: AddressInfo }> =>
  new Promise((resolve, reject) => {
    const server = createAdaptorServer({ fetch });

    const cleanup = (): void => {
      server.off('error', onError);
      server.off('listening', onListening);
    };

    const onError = (error: NodeJS.ErrnoException): void => {
      cleanup();
      reject(error);
    };

    const onListening = (): void => {
      cleanup();
      const address = server.address();

      if (!address || typeof address === 'string') {
        reject(new Error('Failed to resolve bound server address.'));
        return;
      }

      resolve({ server, info: address });
    };

    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });

export const main = async (): Promise<void> => {
  // One-shot migration of legacy ~/.openhermit/{gateway.json, .env, *.pid,
  // *.log} into ~/.openhermit/gateway/. No-op once migrated.
  const moved = await migrateLegacyGatewayLayout();
  if (moved.length > 0) {
    logStartup(`migrated legacy gateway files: ${moved.join(', ')}`);
  }

  // Load .env: ~/.openhermit/gateway/.env (production) then cwd/.env (development).
  const loadedEnvCount = await loadEnv();
  if (loadedEnvCount > 0) {
    logStartup(`loaded ${loadedEnvCount} env var(s)`);
  }

  const instances = new AgentInstanceManager();

  // Open agent store and skill store if DATABASE_URL is available.
  let agentStore: DbAgentStore | undefined;
  let skillStore: DbSkillStore | undefined;
  let scheduleStore: DbScheduleStore | undefined;
  let mcpServerStore: DbMcpServerStore | undefined;
  let userStore: DbUserStore | undefined;
  let configStore: DbAgentConfigStore | undefined;
  let agentChannelStore: DbAgentChannelStore | undefined;
  let instructionStore: DbInstructionStore | undefined;
  let sandboxStore: DbSandboxStore | undefined;
  let policyStore: DbPolicyStore | undefined;
  let approvalRequestStore: DbApprovalRequestStore | undefined;
  let metaStore: DbMetaStore | undefined;
  if (process.env.DATABASE_URL) {
    try {
      await runMigrations();
      logStartup('migrations applied');
      agentStore = await DbAgentStore.open();
      skillStore = await DbSkillStore.open();
      scheduleStore = await DbScheduleStore.open();
      mcpServerStore = await DbMcpServerStore.open();
      userStore = await DbUserStore.open();
      configStore = await DbAgentConfigStore.open();
      instructionStore = await DbInstructionStore.open();
      sandboxStore = await DbSandboxStore.open();
      policyStore = await DbPolicyStore.open();
      approvalRequestStore = await DbApprovalRequestStore.open();
      metaStore = await DbMetaStore.open();
      if (process.env.OPENHERMIT_SECRETS_KEY) {
        agentChannelStore = await DbAgentChannelStore.open();
      }
      logStartup('agent store connected');
    } catch (error) {
      logStartup(`agent store unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Load gateway config (DB-backed when metaStore is available; falls
  // back to gateway.json + defaults otherwise). On first boot with a
  // file present, the loader migrates it into the DB and renames the
  // file to gateway.json.imported.
  const configPath = path.join(resolveGatewayDir(), DEFAULT_CONFIG_FILENAME);
  const { config, source: configSource } = await loadGatewayConfig(
    configPath,
    metaStore ? { metaStore } : {},
  );
  logStartup(`config loaded (source: ${configSource})`);

  // Auth configuration (secrets stay in env). ChannelRegistry is seeded
  // per-agent inside AgentInstanceManager.start() — every channel row
  // (builtin or external) lives in the same agent_channels table and
  // takes the same registration path.
  const channels = new ChannelRegistry();
  if (agentChannelStore) {
    instances.setChannelStore(agentChannelStore);

    // One-shot backfill: for every existing agent, make sure each
    // BUILTIN_CHANNELS kind has a row. If the agent's old
    // config_json.channels.X document has values, copy them into the
    // new row's config field on first create. Idempotent — runs every
    // boot but only inserts the missing rows.
    if (agentStore && configStore) {
      try {
        const { BUILTIN_CHANNELS } = await import('@openhermit/agent/core');
        for (const agent of await agentStore.list()) {
          const legacyConfig = await configStore.getConfig(agent.agentId);
          const legacyChannels = (legacyConfig?.channels ?? {}) as Record<string, Record<string, unknown> | undefined>;
          for (const def of BUILTIN_CHANNELS) {
            const existing = await agentChannelStore.findBuiltin(agent.agentId, def.key);
            if (existing) continue;
            const legacy = legacyChannels[def.key];
            const enabled = !!legacy?.enabled;
            const cfg = legacy ? { ...legacy } : {};
            delete (cfg as { enabled?: unknown }).enabled;
            await agentChannelStore.createBuiltin({
              agentId: agent.agentId,
              channelType: def.key,
              config: cfg,
              enabled,
            });
            logStartup(`backfilled builtin channel row: ${agent.agentId}/${def.key} (enabled=${enabled})`);
          }
        }
      } catch (err) {
        logStartup(`builtin-channel backfill failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  const jwtConfig = createJwtConfig(process.env.GATEWAY_JWT_SECRET);
  if (!process.env.GATEWAY_JWT_SECRET) {
    logStartup('GATEWAY_JWT_SECRET not set — using ephemeral secret (tokens will not survive restarts)');
  }
  const adminToken = process.env.GATEWAY_ADMIN_TOKEN;

  const auth: AuthResolverOptions = {
    userProviders: [new DeviceKeyAuthProvider()],
    channels,
    jwt: jwtConfig,
    adminToken,
  };
  if (!adminToken) {
    logStartup('GATEWAY_ADMIN_TOKEN not set — admin API endpoints are disabled');
  }

  const gatewayDir = path.dirname(fileURLToPath(import.meta.url));
  // Admin UI lives at apps/gateway/ui/dist in the dev tree, but is copied to
  // <package>/public/admin in the published npm bundle. Pick whichever exists.
  const publicDir = (() => {
    if (!config.ui) return undefined;
    const candidates = [
      path.resolve(gatewayDir, '../ui/dist'),     // dev (apps/gateway/dist → apps/gateway/ui/dist)
      path.resolve(gatewayDir, '../public/admin'), // bundled (<pkg>/dist → <pkg>/public/admin)
    ];
    return candidates.find((p) => existsSync(p)) ?? candidates[0];
  })();

  // Pass skill store to instances so agent runners can access DB skills.
  if (mcpServerStore) {
    instances.setMcpServerStore(mcpServerStore);
  }

  if (configStore) {
    instances.setConfigStore(configStore);
    // Prefer the DB-backed encrypted secret store when a key is
    // configured. Fall back to the file-backed store with a warning so
    // existing installs keep working until the operator runs setup
    // again to generate a key.
    if (process.env.OPENHERMIT_SECRETS_KEY) {
      try {
        const dbSecretStore = await DbSecretStore.open();
        // One-shot migration: if the agent has secrets.json on disk but
        // nothing in the DB, copy values over (encrypted) and rename
        // the file. Idempotent across boots.
        if (agentStore) {
          const agents = await agentStore.list();
          for (const agent of agents) {
            try {
              const dataDir = resolveAgentDataDir(agent.agentId);
              const fileStore = new FileSecretStore(async () => dataDir);
              const fileSecrets = await fileStore.list(agent.agentId);
              const dbSecrets = await dbSecretStore.list(agent.agentId);
              if (Object.keys(fileSecrets).length > 0 && Object.keys(dbSecrets).length === 0) {
                await dbSecretStore.setAll(agent.agentId, fileSecrets);
                logStartup(`migrated ${Object.keys(fileSecrets).length} secret(s) from file to DB for agent ${agent.agentId}`);
                const fs = await import('node:fs/promises');
                const oldPath = `${dataDir}/secrets.json`;
                await fs.rename(oldPath, `${oldPath}.imported`).catch(() => undefined);
              }
            } catch (e) {
              logStartup(`secret migration skipped for ${agent.agentId}: ${e instanceof Error ? e.message : String(e)}`);
            }
          }
        }
        instances.setSecretStore(dbSecretStore);
        logStartup('secret store: encrypted (DB)');
      } catch (e) {
        logStartup(`failed to open encrypted secret store: ${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
      }
    } else {
      logStartup('OPENHERMIT_SECRETS_KEY not set — falling back to FileSecretStore (plaintext on disk). Run `hermit setup` to enable encrypted DB-backed secrets.');
      const secretStore = new FileSecretStore(async (agentId: string) => resolveAgentDataDir(agentId));
      instances.setSecretStore(secretStore);
    }
  }

  if (agentStore) {
    instances.setAgentStore(agentStore);
  }

  if (policyStore) {
    instances.setPolicyStore(policyStore);
  }

  if (approvalRequestStore) {
    instances.setApprovalRequestStore(approvalRequestStore);
  }

  if (sandboxStore) {
    instances.setSandboxStore(sandboxStore);
    if (agentStore && configStore) {
      try {
        await backfillSandboxes(agentStore, configStore, sandboxStore, logStartup);
      } catch (error) {
        logStartup(`sandbox backfill failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  if (skillStore) {
    instances.setSkillStore(skillStore);

    // Auto-register built-in skills into DB.
    const builtinSkillsDir = path.resolve(gatewayDir, '../../../skills');
    const builtinSkills = await scanSkillDirectory(builtinSkillsDir, builtinSkillsDir, 'system');
    for (const skill of builtinSkills) {
      const now = new Date().toISOString();
      await skillStore.upsert({
        id: skill.id,
        name: skill.name,
        description: skill.description,
        path: skill.path,
        createdAt: now,
        updatedAt: now,
      });
    }
    if (builtinSkills.length > 0) {
      logStartup(`registered ${builtinSkills.length} built-in skill(s)`);
    }
  }

  const app = createGatewayApp({
    instances,
    ...(agentStore ? { agentStore } : {}),
    ...(skillStore ? { skillStore } : {}),
    ...(scheduleStore ? { scheduleStore } : {}),
    ...(mcpServerStore ? { mcpServerStore } : {}),
    ...(userStore ? { userStore } : {}),
    ...(configStore ? { configStore } : {}),
    ...(agentChannelStore ? { agentChannelStore } : {}),
    ...(instructionStore ? { instructionStore } : {}),
    ...(sandboxStore ? { sandboxStore } : {}),
    ...(policyStore ? { policyStore } : {}),
    ...(approvalRequestStore ? { approvalRequestStore } : {}),
    ...(metaStore ? { metaStore } : {}),
    sandboxPresets: config.sandboxPresets,
    autoProvisionSandbox: config.autoProvisionSandbox,
    channelRegistry: channels,
    auth,
    adminToken,
    logger: logStartup,
    logBuffer,
    publicDir,
    corsOrigin: config.cors.origin,
  });

  if (config.ui) {
    logStartup('admin UI enabled at /admin/');
  }

  // Central scheduler: cross-agent scan of `schedules.next_run_at`. Each
  // due fire hydrates the agent on demand. Replaces the per-runner
  // Scheduler so eviction (Phase 3) doesn't drop cron jobs.
  let centralScheduler: CentralScheduler | undefined;
  if (scheduleStore) {
    centralScheduler = new CentralScheduler(scheduleStore, instances, {
      log: logStartup,
    });
    centralScheduler.start();
    logStartup('central scheduler started');
  } else {
    logStartup('central scheduler skipped (no schedule store)');
  }

  // LRU eviction: scan hydrated runners every minute, stop ones that
  // have been idle past the TTL with no active channels and no live WS
  // subscribers. OPENHERMIT_EVICTION_TTL_MINUTES=0 disables eviction.
  const evictionTTLMinutes = (() => {
    const raw = process.env.OPENHERMIT_EVICTION_TTL_MINUTES;
    if (raw === undefined) return 30;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : 30;
  })();
  if (evictionTTLMinutes > 0) {
    instances.startEviction({
      idleTTLMs: evictionTTLMinutes * 60_000,
      tickIntervalMs: 60_000,
      log: logStartup,
    });
    logStartup(`LRU eviction enabled (idle TTL ${evictionTTLMinutes}m)`);
  } else {
    logStartup('LRU eviction disabled');
  }

  const rawPort = process.env.GATEWAY_PORT ?? process.env.PORT;
  const port = rawPort ? Number.parseInt(rawPort, 10) : 4000;

  if (Number.isNaN(port)) {
    throw new Error(`Invalid port: ${rawPort}`);
  }

  const host = process.env.GATEWAY_HOST ?? '127.0.0.1';

  const { server, info } = await listen(app.fetch, port, host);

  // Channel adapters connect back to the gateway from inside the host. Use
  // 127.0.0.1 even when the public listener is 0.0.0.0 / a specific IP.
  instances.setGatewayBaseUrl(`http://127.0.0.1:${info.port}`);
  instances.setAdminToken(adminToken);
  instances.setChannelRegistry(channels);

  attachGatewayWs(server as import('node:http').Server, {
    instances,
    auth,
    logger: logStartup,
  });

  // Start agents from database after server is listening (channels need the gateway URL).
  if (agentStore && config.autoStartAgents) {
    const dbAgents = await agentStore.list();
    // Pre-load all sandbox rows in a single query so we don't N+1 on boot.
    // Group by agentId; the host-claim invariant below still walks agents
    // sequentially because it's a serial first-wins decision.
    const sandboxByAgent = new Map<string, Array<{ type: string }>>();
    if (sandboxStore) {
      const allSandboxes = await sandboxStore.listAll();
      for (const row of allSandboxes) {
        const arr = sandboxByAgent.get(row.agentId);
        if (arr) arr.push(row);
        else sandboxByAgent.set(row.agentId, [row]);
      }
    }
    // Defensive: if DB tampering produced multiple host sandboxes, only the
    // first agent encountered claims the host backend in this pass. The
    // create-time check (POST /sandboxes) is the primary guard.
    let hostClaimed: string | undefined;
    for (const agent of dbAgents) {
      try {
        if (sandboxStore) {
          const rows = sandboxByAgent.get(agent.agentId) ?? [];
          const wantsHost = rows.some((r) => r.type === 'host');
          if (wantsHost && hostClaimed && hostClaimed !== agent.agentId) {
            logStartup(`skipping agent ${agent.agentId}: host backend already in use by ${hostClaimed}`);
            continue;
          }
          if (wantsHost) hostClaimed = agent.agentId;
        }
        await instances.start(agent.agentId, agent.workspaceDir);
        logStartup(`started agent: ${agent.agentId}`);
      } catch (error) {
        logStartup(`failed to start agent ${agent.agentId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    // Sync platform skills into each agent's exec backends.
    if (skillStore) {
      for (const agent of dbAgents) {
        const runner = instances.getRunner(agent.agentId);
        if (runner) {
          await syncSkillMounts(agent.agentId, runner, skillStore);
        }
      }
    }
    logStartup(`${dbAgents.length} agent(s) loaded`);
  } else if (agentStore && !config.autoStartAgents) {
    logStartup('autoStartAgents disabled — agents will not be started automatically');
  }

  // Re-entrancy guard: SIGINT + SIGTERM can both fire in quick succession
  // (e.g. supervisor sends TERM, then user presses Ctrl-C). Calling
  // pool.end() twice throws, and the unhandledRejection safety net below
  // would then keep a zombie gateway alive with closed DB pools.
  let shuttingDown = false;
  const shutdownHandler = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logStartup('shutting down...');

    await centralScheduler?.stop();
    instances.stopEviction();
    await instances.stopAll();
    await agentStore?.close();
    await skillStore?.close();
    await scheduleStore?.close();
    await mcpServerStore?.close();

    server.close(() => {
      logStartup('server closed');
      process.exit(0);
    });
  };

  process.on('SIGINT', () => void shutdownHandler());
  process.on('SIGTERM', () => void shutdownHandler());

  // Don't let a single agent's runtime error take down the entire
  // gateway — log loudly and keep running. Real fixes belong at the
  // throw site; these handlers are operational safety nets so other
  // agents stay online.
  process.on('uncaughtException', (err) => {
    console.error('[openhermit-gateway] uncaughtException — keeping gateway alive', err);
  });
  process.on('unhandledRejection', (reason) => {
    console.error('[openhermit-gateway] unhandledRejection — keeping gateway alive', reason);
  });

  logStartup(`listening on http://${host === '0.0.0.0' ? '0.0.0.0' : info.address}:${info.port}`);
};

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main().catch((error) => {
    stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
