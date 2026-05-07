import path from 'node:path';

import { AgentRunner } from '@openhermit/agent/agent-runner';
import { AgentSecurity, AgentWorkspace } from '@openhermit/agent/core';
import {
  createLangfuseClientFromEnv,
  createLangfuseShutdownHandler,
  type LangfuseClientLike,
} from '@openhermit/agent/langfuse';
import { startChannels, startSingleChannel, stopChannels, type ChannelStatus, type WebhookRequest, type WebhookResponse } from '@openhermit/agent/channels';
import type { AgentConfigStore, AgentStore, ApprovalRequestStore, McpServerStore, PolicyStore, SandboxStore, SecretStore, SkillStore } from '@openhermit/store';

import type { ChannelRegistry } from './auth.js';

const log = (message: string): void => {
  console.log(`[openhermit-gateway] ${message}`);
};

interface ChannelHandle {
  name: string;
  stop: () => Promise<void>;
  handleWebhook?: (req: WebhookRequest) => Promise<WebhookResponse>;
}

export class AgentInstanceManager {
  private runners = new Map<string, AgentRunner>();
  /**
   * In-flight hydrations. Concurrent {@link getOrHydrate} calls for the
   * same cold agent share one start() invocation rather than racing —
   * the first caller installs a Promise here, others await it.
   */
  private hydrating = new Map<string, Promise<AgentRunner>>();
  private langfuseClients = new Map<string, LangfuseClientLike>();
  private channelHandles = new Map<string, ChannelHandle[]>();
  private channelStatuses = new Map<string, ChannelStatus[]>();

  /** Gateway base URL used for channel adapters to connect back. */
  private gatewayBaseUrl: string | undefined;
  /** Admin token forwarded to channel adapters for gateway auth. */
  private adminToken: string | undefined;
  /** Shared channel registry for external channel token auth. */
  private channelRegistry: ChannelRegistry | undefined;
  /** Shared skill store for DB-managed skills. */
  private skillStore: SkillStore | undefined;
  /** Shared MCP server store for DB-managed MCP servers. */
  private mcpServerStore: McpServerStore | undefined;
  /** DB-backed agent config + security policy store. */
  private configStore: AgentConfigStore | undefined;
  /** File-backed (today) secret store. */
  private secretStore: SecretStore | undefined;
  /** DB-backed agent store (for backend state persistence). */
  private agentStore: AgentStore | undefined;
  /** DB-backed sandbox store (one row per agent sandbox). */
  private sandboxStore: SandboxStore | undefined;
  /** DB-backed policy store (tool/resource access grants). */
  private policyStore: PolicyStore | undefined;
  /** DB-backed channel store (builtin + external rows, encrypted tokens). */
  private channelStore: import('@openhermit/store').DbAgentChannelStore | undefined;

  setGatewayBaseUrl(url: string): void {
    this.gatewayBaseUrl = url;
  }

  setAdminToken(token: string | undefined): void {
    this.adminToken = token;
  }

  setChannelRegistry(registry: ChannelRegistry): void {
    this.channelRegistry = registry;
  }

  setSkillStore(store: SkillStore): void {
    this.skillStore = store;
  }

  setMcpServerStore(store: McpServerStore): void {
    this.mcpServerStore = store;
  }

  setConfigStore(store: AgentConfigStore): void {
    this.configStore = store;
  }

  setSecretStore(store: SecretStore): void {
    this.secretStore = store;
  }

  setAgentStore(store: AgentStore): void {
    this.agentStore = store;
  }

  setSandboxStore(store: SandboxStore): void {
    this.sandboxStore = store;
  }

  getSandboxStore(): SandboxStore | undefined {
    return this.sandboxStore;
  }

  setPolicyStore(store: PolicyStore): void {
    this.policyStore = store;
  }

  private approvalRequestStore: ApprovalRequestStore | undefined;

  setApprovalRequestStore(store: ApprovalRequestStore): void {
    this.approvalRequestStore = store;
  }

  setChannelStore(store: import('@openhermit/store').DbAgentChannelStore): void {
    this.channelStore = store;
  }

  getConfigStore(): AgentConfigStore | undefined {
    return this.configStore;
  }

  getSecretStore(): SecretStore | undefined {
    return this.secretStore;
  }


  /**
   * Create and start an in-process AgentRunner for the given agent.
   *
   * Synchronously fences via {@link hydrating} so the boot loop and a
   * concurrent {@link getOrHydrate} can't both fall into `_doStart` —
   * `runners.set` happens after the AgentRunner.create await, leaving a
   * window where two callers each see an empty Map.
   */
  async start(agentId: string, workspaceDir: string): Promise<AgentRunner> {
    if (this.runners.has(agentId)) {
      throw new Error(`AgentRunner for "${agentId}" is already running.`);
    }
    const inFlight = this.hydrating.get(agentId);
    if (inFlight) return inFlight;
    const promise = this._doStart(agentId, workspaceDir);
    this.hydrating.set(agentId, promise);
    try {
      return await promise;
    } finally {
      this.hydrating.delete(agentId);
    }
  }

  private async _doStart(
    agentId: string,
    workspaceDir: string,
  ): Promise<AgentRunner> {
    // 1. Workspace
    const workspace = new AgentWorkspace(workspaceDir);
    log(`[${agentId}] initialising workspace: ${workspaceDir}`);
    await workspace.init({ agentId });

    if (!this.configStore || !this.secretStore) {
      throw new Error(
        'AgentInstanceManager requires configStore and secretStore (call setConfigStore/setSecretStore at startup).',
      );
    }

    // 2. Security — config/policy/secrets live in the database; nothing on disk.
    const security = new AgentSecurity({
      agentId,
      workspace,
      configStore: this.configStore,
      secretStore: this.secretStore,
    });
    await security.load();

    // 3. Reconcile workspace_root in the persisted config
    const initialConfig = await security.readConfig();
    if (initialConfig.workspace_root !== workspaceDir) {
      await security.writeConfig({
        ...initialConfig,
        workspace_root: workspaceDir,
      });
    }

    log(`[${agentId}] access: ${security.getAccessLevel()}`);

    // 4. Optional Langfuse tracing
    const langfuse = createLangfuseClientFromEnv({ logger: log });
    if (langfuse) {
      this.langfuseClients.set(agentId, langfuse);
      log(`[${agentId}] Langfuse tracing enabled`);
    }

    // 5. Create the runner
    const runner = await AgentRunner.create({
      workspace,
      security,
      ...(langfuse ? { langfuse } : {}),
      ...(this.skillStore ? { skillStore: this.skillStore } : {}),
      ...(this.mcpServerStore ? { mcpServerStore: this.mcpServerStore } : {}),
      ...(this.sandboxStore ? { sandboxStore: this.sandboxStore } : {}),
      ...(this.policyStore ? { policyStore: this.policyStore } : {}),
      ...(this.approvalRequestStore ? { approvalRequestStore: this.approvalRequestStore } : {}),
    });

    this.runners.set(agentId, runner);
    log(`[${agentId}] runner started`);

    // 6. Load channel rows (builtin + external) from DB. Each row's encrypted
    //    token is registered in ChannelRegistry; for enabled builtin rows we
    //    additionally boot the in-process bridge using row.config.
    if (this.channelStore && this.gatewayBaseUrl) {
      try {
        const allActive = await this.channelStore.loadActive();
        const myChannels = allActive.filter((c) => c.agentId === agentId);

        if (this.channelRegistry) {
          for (const ch of myChannels) {
            this.channelRegistry.register({
              channelId: ch.id,
              apiKey: ch.token,
              namespace: ch.namespace,
              agentId,
            });
          }
        }

        const enabledBuiltins = myChannels.filter((c) => c.kind === 'builtin' && c.enabled);
        if (enabledBuiltins.length > 0) {
          const agentBaseUrl = `${this.gatewayBaseUrl}/api/agents/${encodeURIComponent(agentId)}`;
          const channelsConfig: Record<string, unknown> = {};
          const agentTokens: Record<string, string> = {};
          for (const ch of enabledBuiltins) {
            // Resolve ${{SECRET}} placeholders before handing config to the bridge.
            const resolved = await security.expandSecrets({ ...ch.config, enabled: true });
            channelsConfig[ch.channelType] = resolved;
            agentTokens[ch.channelType] = ch.token;
          }

          const { handles, statuses } = await startChannels(channelsConfig as never, {
            agentBaseUrl,
            agentTokens,
            logger: (channel, msg) => log(`[${agentId}] [${channel}] ${msg}`),
          });
          if (statuses.length > 0) this.channelStatuses.set(agentId, statuses);
          if (handles.length > 0) {
            this.channelHandles.set(agentId, handles);
            for (const handle of handles) {
              if (handle.outbound) runner.registerChannelOutbound(handle.outbound);
            }
            log(`[${agentId}] started ${handles.length} channel(s): ${handles.map((h) => h.name).join(', ')}`);
          }
        }
      } catch (error) {
        log(`[${agentId}] failed to load/start channels: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // 8. Start background timers (stale-session sweep, etc.). Schedule
    //    firing happens at the gateway level (see CentralScheduler).
    runner.startBackgroundTimers();

    return runner;
  }

  /** Retrieve a running AgentRunner by agent ID, if one exists. */
  getRunner(agentId: string): AgentRunner | undefined {
    return this.runners.get(agentId);
  }

  /**
   * Resolve an AgentRunner for a cold-path request, hydrating on demand.
   *
   * Returns:
   *   - the existing runner if already hydrated;
   *   - the in-flight hydration Promise if another caller is mid-start;
   *   - a freshly hydrated runner if `agents.status = 'active'`;
   *   - `undefined` if the agent doesn't exist or is not active.
   *
   * Concurrent callers for the same cold agent share one hydration via
   * {@link hydrating}, so we never race two `start()` calls.
   *
   * Callers that only want to check liveness without triggering work
   * should keep using {@link getRunner}.
   */
  async getOrHydrate(agentId: string): Promise<AgentRunner | undefined> {
    const existing = this.runners.get(agentId);
    if (existing) return existing;

    const inFlight = this.hydrating.get(agentId);
    if (inFlight) return inFlight;

    if (!this.agentStore) {
      throw new Error(
        'AgentInstanceManager.getOrHydrate requires agentStore (call setAgentStore at startup).',
      );
    }
    const record = await this.agentStore.get(agentId);
    if (!record) return undefined;
    if (record.status !== 'active') return undefined;

    // Re-check after the await — another caller may have hydrated meanwhile.
    const reCheck = this.runners.get(agentId);
    if (reCheck) return reCheck;
    const reInFlight = this.hydrating.get(agentId);
    if (reInFlight) return reInFlight;

    // start() handles the hydrating-map fence itself.
    return this.start(agentId, record.workspaceDir);
  }

  getChannelStatuses(agentId: string): ChannelStatus[] {
    return this.channelStatuses.get(agentId) ?? [];
  }

  /**
   * Dispatch an incoming webhook request to the named channel adapter
   * for `agentId`. Hydrates the agent on demand if the request is for
   * an `active` agent that isn't currently running. Returns 404 if the
   * agent doesn't exist / is disabled / the channel isn't enabled / the
   * adapter doesn't accept webhooks.
   */
  async dispatchWebhook(agentId: string, channelName: string, req: WebhookRequest): Promise<WebhookResponse> {
    if (!this.runners.has(agentId)) {
      const runner = await this.getOrHydrate(agentId);
      if (!runner) {
        return { status: 404, body: 'agent not available' };
      }
    }
    const handles = this.channelHandles.get(agentId) ?? [];
    const handle = handles.find((h) => h.name === channelName);
    if (!handle || !handle.handleWebhook) {
      return { status: 404, body: 'channel not active or does not accept webhooks' };
    }
    return handle.handleWebhook(req);
  }

  async stopSingleChannel(agentId: string, channelName: string, log: (msg: string) => void): Promise<void> {
    const handles = this.channelHandles.get(agentId) ?? [];
    const idx = handles.findIndex((h) => h.name === channelName);
    if (idx !== -1) {
      const handle = handles[idx]!;
      try {
        await handle.stop();
      } catch (err) {
        log(`[${agentId}] error stopping ${channelName}: ${err instanceof Error ? err.message : String(err)}`);
      }
      handles.splice(idx, 1);
      if (handles.length === 0) this.channelHandles.delete(agentId);

      const runner = this.runners.get(agentId);
      if (runner) {
        runner.getChannelOutbound().delete(channelName);
      }
    }

    if (this.channelRegistry) {
      this.channelRegistry.unregister(`${agentId}:${channelName}:builtin`);
    }

    const statuses = this.channelStatuses.get(agentId) ?? [];
    const sIdx = statuses.findIndex((s) => s.name === channelName);
    if (sIdx !== -1) statuses.splice(sIdx, 1);

    log(`[${agentId}] stopped channel: ${channelName}`);
  }

  /**
   * Start a single builtin channel (used by the enable-channel API). The
   * row in agent_channels must already be enabled and have config; we
   * just spawn the in-process bridge and register the row's token in the
   * live ChannelRegistry.
   */
  async startSingleChannel(agentId: string, channelName: string, log: (msg: string) => void): Promise<ChannelStatus> {
    const runner = this.runners.get(agentId);
    if (!runner || !this.gatewayBaseUrl) {
      return { name: channelName, status: 'error', error: 'Agent not running' };
    }
    if (!this.channelStore) {
      return { name: channelName, status: 'error', error: 'Channel store not configured' };
    }

    const row = await this.channelStore.findBuiltin(agentId, channelName);
    if (!row || !row.enabled) {
      return { name: channelName, status: 'error', error: `Builtin channel ${channelName} is not enabled` };
    }

    // Decrypt the token via loadActive (we don't expose decrypt directly).
    const all = await this.channelStore.loadActive();
    const loaded = all.find((c) => c.id === row.id);
    if (!loaded) {
      return { name: channelName, status: 'error', error: 'Failed to decrypt channel token' };
    }

    const agentBaseUrl = `${this.gatewayBaseUrl}/api/agents/${encodeURIComponent(agentId)}`;
    if (this.channelRegistry) {
      this.channelRegistry.register({
        channelId: row.id,
        apiKey: loaded.token,
        namespace: row.namespace,
        agentId,
      });
    }

    const resolvedRow = await runner.security.expandSecrets({ ...row.config, enabled: true });
    const channelsConfig: Record<string, unknown> = { [channelName]: resolvedRow };

    const { handle, status } = await startSingleChannel(channelName, channelsConfig as never, {
      agentBaseUrl,
      agentTokens: { [channelName]: loaded.token },
      logger: (channel, msg) => log(`[${agentId}] [${channel}] ${msg}`),
    });

    if (handle) {
      const handles = this.channelHandles.get(agentId) ?? [];
      handles.push(handle);
      this.channelHandles.set(agentId, handles);
      if (handle.outbound) {
        runner.registerChannelOutbound(handle.outbound);
      }
      log(`[${agentId}] started channel: ${channelName}`);
    }

    const statuses = this.channelStatuses.get(agentId) ?? [];
    const existingIdx = statuses.findIndex((s) => s.name === channelName);
    if (existingIdx !== -1) {
      statuses[existingIdx] = status;
    } else {
      statuses.push(status);
    }
    this.channelStatuses.set(agentId, statuses);

    return status;
  }

  /** Get all running agent IDs. */
  getRunningAgentIds(): string[] {
    return [...this.runners.keys()];
  }

  /** List all running agent IDs. */
  listRunnerIds(): string[] {
    return [...this.runners.keys()];
  }

  /** Stop a single agent, flushing Langfuse and cleaning up resources. */
  async stop(agentId: string): Promise<void> {
    const runner = this.runners.get(agentId);
    if (!runner) {
      return;
    }

    // Unregister channel tokens.
    this.channelRegistry?.unregisterByAgent(agentId);

    // Stop channels first.
    const handles = this.channelHandles.get(agentId);
    if (handles) {
      await stopChannels(handles);
      this.channelHandles.delete(agentId);
    }
    this.channelStatuses.delete(agentId);

    await runner.shutdown();

    const langfuse = this.langfuseClients.get(agentId);
    if (langfuse) {
      const shutdown = createLangfuseShutdownHandler(langfuse);
      await shutdown();
      this.langfuseClients.delete(agentId);
    }

    this.runners.delete(agentId);
    log(`[${agentId}] runner stopped`);
  }

  /** Stop every managed agent. */
  async stopAll(): Promise<void> {
    const ids = [...this.runners.keys()];
    await Promise.all(ids.map((id) => this.stop(id)));
  }
}
