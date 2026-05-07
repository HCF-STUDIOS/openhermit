import path from 'node:path';

import { AgentRunner } from '@openhermit/agent/agent-runner';
import { AgentSecurity, AgentWorkspace } from '@openhermit/agent/core';
import {
  createLangfuseClientFromEnv,
  createLangfuseShutdownHandler,
  type LangfuseClientLike,
} from '@openhermit/agent/langfuse';
import type { AgentConfigStore, AgentStore, ApprovalRequestStore, McpServerStore, PolicyStore, SandboxStore, SecretStore, SkillStore } from '@openhermit/store';

import type { ChannelPool } from './channel-pool.js';

const log = (message: string): void => {
  console.log(`[openhermit-gateway] ${message}`);
};

export interface EvictionOptions {
  /** Idle threshold; runners untouched for this long are evictable. */
  idleTTLMs: number;
  /** How often to scan. */
  tickIntervalMs: number;
  log?: (message: string) => void;
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

  /** Last activity timestamp per agent, used by LRU eviction. */
  private lastActivityAt = new Map<string, number>();
  /** Live WebSocket connection count per agent. */
  private wsConnections = new Map<string, number>();
  /** Per-agent busy counter — long-running ops increment to fence eviction. */
  private busy = new Map<string, number>();
  private evictionTimer: ReturnType<typeof setInterval> | undefined;

  /** Admin token forwarded to channel adapters for gateway auth. */
  private adminToken: string | undefined;
  /**
   * Channel connection pool — owns bridge lifecycle independent of
   * runners. Optional during early boot wiring; must be set before any
   * runner hydrates so the runner can pick up live outbounds.
   */
  private channelPool: ChannelPool | undefined;
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
  setAdminToken(token: string | undefined): void {
    this.adminToken = token;
  }

  setChannelPool(pool: ChannelPool): void {
    this.channelPool = pool;
  }

  getChannelPool(): ChannelPool | undefined {
    return this.channelPool;
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

    // 6. Wire outbounds from the gateway-level channel pool. Bridges are
    //    owned by the pool and persist across runner eviction; we just
    //    register their send-callbacks on this freshly hydrated runner.
    if (this.channelPool) {
      const handles = this.channelPool.getOutbounds(agentId);
      for (const handle of handles) {
        if (handle.outbound) runner.registerChannelOutbound(handle.outbound);
      }
      if (handles.length > 0) {
        log(`[${agentId}] attached ${handles.length} pool channel(s): ${handles.map((h) => h.name).join(', ')}`);
      }
    }

    // 8. Start background timers (stale-session sweep, etc.). Schedule
    //    firing happens at the gateway level (see CentralScheduler).
    runner.startBackgroundTimers();

    this.touch(agentId);
    return runner;
  }

  /** Retrieve a running AgentRunner by agent ID, if one exists. */
  getRunner(agentId: string): AgentRunner | undefined {
    const runner = this.runners.get(agentId);
    if (runner) this.touch(agentId);
    return runner;
  }

  /** Mark the agent as recently active so eviction skips it. */
  touch(agentId: string): void {
    if (this.runners.has(agentId)) {
      this.lastActivityAt.set(agentId, Date.now());
    }
  }

  /** Increment the live WS connection count for `agentId` (also touches). */
  wsConnect(agentId: string): void {
    this.wsConnections.set(agentId, (this.wsConnections.get(agentId) ?? 0) + 1);
    this.touch(agentId);
  }

  /** Decrement the live WS connection count for `agentId`. */
  wsDisconnect(agentId: string): void {
    const current = this.wsConnections.get(agentId) ?? 0;
    if (current <= 1) this.wsConnections.delete(agentId);
    else this.wsConnections.set(agentId, current - 1);
  }

  /**
   * Run `fn` while marking the agent busy so eviction skips it. Use for
   * long ops (scheduled jobs, batch tool calls) that hold the runner
   * past the idle TTL without producing per-step touch events.
   */
  async withBusy<T>(agentId: string, fn: () => Promise<T>): Promise<T> {
    this.busy.set(agentId, (this.busy.get(agentId) ?? 0) + 1);
    this.touch(agentId);
    try {
      return await fn();
    } finally {
      const n = this.busy.get(agentId) ?? 0;
      if (n <= 1) this.busy.delete(agentId);
      else this.busy.set(agentId, n - 1);
      this.touch(agentId);
    }
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
    if (existing) {
      this.touch(agentId);
      return existing;
    }

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

  /** Get all running agent IDs. */
  getRunningAgentIds(): string[] {
    return [...this.runners.keys()];
  }

  /** List all running agent IDs. */
  listRunnerIds(): string[] {
    return [...this.runners.keys()];
  }

  /**
   * Stop a single agent's runner. Channel bridges are NOT torn down —
   * they're owned by ChannelPool and persist across runner eviction so
   * a hot agent can be evicted without dropping inbound messages.
   */
  async stop(agentId: string): Promise<void> {
    const runner = this.runners.get(agentId);
    if (!runner) {
      return;
    }

    await runner.shutdown();

    const langfuse = this.langfuseClients.get(agentId);
    if (langfuse) {
      const shutdown = createLangfuseShutdownHandler(langfuse);
      await shutdown();
      this.langfuseClients.delete(agentId);
    }

    this.runners.delete(agentId);
    this.lastActivityAt.delete(agentId);
    this.wsConnections.delete(agentId);
    this.busy.delete(agentId);
    log(`[${agentId}] runner stopped`);
  }

  /**
   * Start the LRU eviction ticker. Periodically scans hydrated runners
   * and stops those idle longer than `idleTTLMs`.
   *
   * Skipped (kept warm):
   *   - agents with live WebSocket connections;
   *   - agents currently busy (long-running ops).
   *
   * Channels no longer keep agents warm — bridges are owned by
   * ChannelPool, so an evicted runner re-hydrates on the next inbound
   * message via the gateway HTTP route. Schedules also don't keep
   * agents warm — the central scheduler hydrates on demand at fire time.
   */
  startEviction(options: EvictionOptions): void {
    if (this.evictionTimer) return;
    const log = options.log ?? (() => {});
    const tick = (): void => void this.evictionTick(options.idleTTLMs, log);
    this.evictionTimer = setInterval(tick, options.tickIntervalMs);
    this.evictionTimer.unref?.();
  }

  stopEviction(): void {
    if (this.evictionTimer) {
      clearInterval(this.evictionTimer);
      this.evictionTimer = undefined;
    }
  }

  private async evictionTick(
    idleTTLMs: number,
    log: (message: string) => void,
  ): Promise<void> {
    const now = Date.now();
    const candidates: string[] = [];
    for (const agentId of this.runners.keys()) {
      if ((this.wsConnections.get(agentId) ?? 0) > 0) continue;
      if ((this.busy.get(agentId) ?? 0) > 0) continue;
      const last = this.lastActivityAt.get(agentId) ?? now;
      if (now - last < idleTTLMs) continue;
      candidates.push(agentId);
    }
    for (const agentId of candidates) {
      // Re-check guards immediately before stopping in case a request
      // arrived between the scan and now.
      if ((this.wsConnections.get(agentId) ?? 0) > 0) continue;
      if ((this.busy.get(agentId) ?? 0) > 0) continue;
      const last = this.lastActivityAt.get(agentId) ?? now;
      if (now - last < idleTTLMs) continue;
      log(`[${agentId}] evicting idle runner (idle ${Math.round((now - last) / 1000)}s)`);
      try {
        await this.stop(agentId);
      } catch (err) {
        log(`[${agentId}] eviction failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /** Stop every managed agent. */
  async stopAll(): Promise<void> {
    const ids = [...this.runners.keys()];
    await Promise.all(ids.map((id) => this.stop(id)));
  }
}
