import type { AddressInfo } from 'node:net';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stderr } from 'node:process';
import { LogBuffer } from './log-buffer.js';

import { createAdaptorServer } from '@hono/node-server';

import {
  DbAgentStore,
  DbSessionStore,
  DbInstructionStore,
  DbAgentConfigStore,
  DbMcpServerStore,
  DbSandboxStore,
  DbPolicyStore,
  DbApprovalRequestStore,
  DbAttachmentStore,
  DbScheduleStore,
  DbSkillStore,
  DbUserStore,
  FileSecretStore,
  DbSecretStore,
  DbAgentChannelStore,
  DbMetaStore,
  LocalAttachmentStorage,
  S3AttachmentStorage,
  SupabaseAttachmentStorage,
  type AttachmentStorage,
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
import { ChannelPool } from './channel-pool.js';
import { CentralScheduler } from './central-scheduler.js';
import { backfillSandboxes } from './sandbox-backfill.js';
import { createGatewayApp } from './app.js';
import { buildChannelManifestRegistry } from './channel-manifests.js';
import {
  loadGatewayConfig,
  type AttachmentStorageConfig,
  type GatewayConfig,
} from './config.js';
import { attachGatewayWs } from './ws-handler.js';
import {
  type AuthResolverOptions,
  ChannelRegistry,
  DeviceKeyAuthProvider,
  createJwtConfig,
} from './auth.js';

const DEFAULT_CONFIG_FILENAME = 'gateway.json';

/**
 * Resolve the attachment storage provider from gateway config. Credentials
 * and credential-bound pointers come from env: AWS default chain for S3,
 * `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` for Supabase. Non-secret
 * resource pointers (provider, bucket, region, prefix, endpoint, root) live
 * in the gateway config under `attachments.storage` — DB-backed, edited via
 * the admin UI or seeded from gateway.json on first boot. Falls back to
 * local-disk storage when no block is configured.
 */
const buildAttachmentStorage = async (
  config: GatewayConfig,
  log: (message: string) => void,
): Promise<AttachmentStorage> => {
  const storageConfig: AttachmentStorageConfig =
    config.attachments?.storage ?? { provider: 'local' };

  if (storageConfig.provider === 's3') {
    log(`attachment storage: s3 bucket=${storageConfig.bucket}`);
    const opts: Parameters<typeof S3AttachmentStorage.open>[0] = {
      bucket: storageConfig.bucket,
    };
    if (storageConfig.region !== undefined) opts.region = storageConfig.region;
    if (storageConfig.prefix !== undefined) opts.prefix = storageConfig.prefix;
    if (storageConfig.endpoint !== undefined) opts.endpoint = storageConfig.endpoint;
    if (storageConfig.forcePathStyle !== undefined) {
      opts.forcePathStyle = storageConfig.forcePathStyle;
    }
    if (storageConfig.signedUrlExpiresIn !== undefined) {
      opts.signedUrlExpiresIn = storageConfig.signedUrlExpiresIn;
    }
    return S3AttachmentStorage.open(opts);
  }

  if (storageConfig.provider === 'supabase') {
    log(`attachment storage: supabase bucket=${storageConfig.bucket}`);
    const opts: Parameters<typeof SupabaseAttachmentStorage.open>[0] = {
      bucket: storageConfig.bucket,
    };
    if (storageConfig.prefix !== undefined) opts.prefix = storageConfig.prefix;
    if (storageConfig.signedUrlExpiresIn !== undefined) {
      opts.signedUrlExpiresIn = storageConfig.signedUrlExpiresIn;
    }
    return SupabaseAttachmentStorage.open(opts);
  }

  const root =
    storageConfig.root ?? path.join(resolveOpenHermitHome(), 'attachments');
  log(`attachment storage: local root=${root}`);
  return new LocalAttachmentStorage({ root });
};

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
  let attachmentStore: DbAttachmentStore | undefined;
  let metaStore: DbMetaStore | undefined;
  let sessionStore: DbSessionStore | undefined;
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
      attachmentStore = await DbAttachmentStore.open();
      metaStore = await DbMetaStore.open();
      sessionStore = await DbSessionStore.open();
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

  // Build the channel manifest registry: dynamic-import built-in channel
  // packages first, then any external packages from config.channelPackages.
  // External packages may override a built-in by matching its key.
  const manifestRegistry = await buildChannelManifestRegistry(
    config.channelPackages,
    logStartup,
  );

  // Auth configuration (secrets stay in env). ChannelRegistry is seeded
  // by ChannelPool.start() at gateway boot — every channel row (builtin
  // or external) lives in the same agent_channels table and takes the
  // same registration path.
  const channels = new ChannelRegistry();
  if (agentChannelStore) {
    // One-shot backfill: for every existing agent, make sure each
    // registered builtin channel kind has a row. If the agent's old
    // config_json.channels.X document has values, copy them into the
    // new row's config field on first create. Idempotent — runs every
    // boot but only inserts the missing rows.
    if (agentStore && configStore) {
      try {
        const builtinKeys = manifestRegistry.keys();
        for (const agent of await agentStore.list()) {
          const legacyConfig = await configStore.getConfig(agent.agentId);
          const legacyChannels = (legacyConfig?.channels ?? {}) as Record<string, Record<string, unknown> | undefined>;
          for (const key of builtinKeys) {
            const existing = await agentChannelStore.findBuiltin(agent.agentId, key);
            if (existing) continue;
            const legacy = legacyChannels[key];
            const enabled = !!legacy?.enabled;
            // Seed config from manifest.defaultConfig (carries `${{SECRET}}`
            // placeholders) so the interpolation step has something to
            // expand at start time. Legacy values from the pre-DB
            // `channels` blob, if any, override the defaults.
            const defaults = manifestRegistry.get(key)?.defaultConfig ?? {};
            const cfg: Record<string, unknown> = legacy
              ? { ...defaults, ...legacy }
              : { ...defaults };
            delete (cfg as { enabled?: unknown }).enabled;
            await agentChannelStore.createBuiltin({
              agentId: agent.agentId,
              channelType: key,
              config: cfg,
              enabled,
            });
            logStartup(`backfilled builtin channel row: ${agent.agentId}/${key} (enabled=${enabled})`);
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

  // Build attachment storage (local/s3/supabase per gateway config) once so
  // both the HTTP layer and the AgentInstanceManager share the same
  // provider instance. When no DATABASE_URL is set we have no attachment
  // store either, so just skip — the agent tools no-op gracefully.
  const attachmentStorage = attachmentStore
    ? await buildAttachmentStorage(config, logStartup)
    : undefined;

  if (attachmentStore) {
    instances.setAttachmentStore(attachmentStore);
  }
  if (attachmentStorage) {
    instances.setAttachmentStorage(attachmentStorage);
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
        slug: skill.id,
        name: skill.name,
        description: skill.description,
        path: skill.path,
        source: 'system',
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
    ...(attachmentStore ? { attachmentStore } : {}),
    ...(attachmentStorage ? { attachmentStorage } : {}),
    ...(config.attachments?.limits?.maxBytes !== undefined
      ? { attachmentMaxBytes: config.attachments.limits.maxBytes }
      : {}),
    ...(metaStore ? { metaStore } : {}),
    ...(sessionStore ? { sessionStore } : {}),
    sandboxPresets: config.sandboxPresets,
    autoProvisionSandbox: config.autoProvisionSandbox,
    channelRegistry: channels,
    manifestRegistry,
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

  instances.setAdminToken(adminToken);

  // Boot the channel pool — owns Telegram/Slack/Discord bridges
  // independently of runners. Channels stay alive across runner
  // eviction; the bridge calls back via HTTP, hydrating the runner on
  // demand for inbound messages.
  let channelPool: ChannelPool | undefined;
  if (agentChannelStore && agentStore && configStore) {
    const secretStore = instances.getSecretStore();
    if (secretStore) {
      const publicGatewayBaseUrl = process.env.OPENHERMIT_GATEWAY_PUBLIC_URL?.replace(/\/+$/, '');
      channelPool = new ChannelPool({
        agentStore,
        channelStore: agentChannelStore,
        configStore,
        secretStore,
        channelRegistry: channels,
        manifestRegistry,
        // Channel adapters connect back from inside the host. Use
        // 127.0.0.1 even when the public listener is 0.0.0.0.
        gatewayBaseUrl: `http://127.0.0.1:${info.port}`,
        ...(publicGatewayBaseUrl ? { publicGatewayBaseUrl } : {}),
        getRunner: (agentId) => instances.getRunner(agentId),
        log: logStartup,
      });
      instances.setChannelPool(channelPool);
      try {
        await channelPool.start();
        logStartup('channel pool started');
      } catch (err) {
        logStartup(`channel pool start failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      logStartup('channel pool skipped (no secret store available)');
    }
  }

  attachGatewayWs(server as import('node:http').Server, {
    instances,
    auth,
    logger: logStartup,
  });

  // Agents hydrate lazily on first request — no boot-time iteration.
  // Channel pool already loaded all bridges above so inbound traffic
  // works before any runner exists. The host-backend single-claim
  // invariant is enforced at sandbox-create time (POST /sandboxes).
  if (agentStore) {
    const count = (await agentStore.list()).length;
    logStartup(`${count} agent(s) registered (lazy hydration)`);
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
    await channelPool?.stopAll();
    await instances.stopAll();
    await agentStore?.close();
    await skillStore?.close();
    await scheduleStore?.close();
    await mcpServerStore?.close();
    await sessionStore?.close();
    await attachmentStore?.close();

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
