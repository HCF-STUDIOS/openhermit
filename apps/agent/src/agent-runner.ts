import { userInfo } from 'node:os';
import { randomBytes } from 'node:crypto';

import { Agent, type AgentEvent, type AgentMessage } from '@mariozechner/pi-agent-core';
import type { MessageSender, SessionHistoryMessage, SessionListQuery, SessionMessage, SessionSpec, SessionSummary } from '@openhermit/protocol';
import { NotFoundError, ValidationError, getErrorMessage } from '@openhermit/shared';
import {
  type InternalStateStore,
  type StoreScope,
  type UserRole,
  DbInternalStateStore,
} from '@openhermit/store';

import {
  AgentSecurity,
  AgentWorkspace,
  DEFAULT_INTROSPECTION_CONFIG,
  DockerContainerManager,
  ExecBackendManager,
  buildPrincipal,
  evaluateAccess,
  parseMcpServerId,
  resolveMcpMatches,
  resolveToolMatches,
  type AgentConfig,
  type PolicyRow,
} from './core/index.js';
import { ApprovalGate } from './agent-runner/approval-gate.js';
import { buildSystemPrompt } from './agent-runner/prompt.js';
import { AgentEventBus } from './events.js';
import { buildSessionSummaries, createPersistedSessionIndexEntry } from './agent-runner/session-index.js';
import type { AgentRunnerOptions, RunnerSession } from './agent-runner/types.js';
import {
  createProviderSecretCandidates,
  formatMissingApiKeyMessage,
  resolveModel,
} from './agent-runner/model-utils.js';
import {
  createUserMessage,
  extractAssistantText,
  extractThinkingText,
  extractThinkingSignature,
  hasMeaningfulAssistantText,
  extractToolResultDetails,
  extractToolResultText,
  isAssistantMessage,
  serializeDetails,
} from './agent-runner/message-utils.js';
import {
  createFallbackDescription,
} from './session-utils.js';
import {
  createLangfuseTracedStreamFn,
  endTurnTrace,
  type LangfuseTurnContext,
  startTurnTrace,
} from './langfuse.js';
import { type Caller, type SessionDescriptor, SessionEventBroker, type SessionRuntime } from './runtime.js';
export type { SessionEventEnvelope } from './runtime.js';
import {
  type ApprovalCallback,
  type ApprovalDecision,
  type Toolset,
  type ToolCallCallback,
  createBuiltInToolsets,
  toolsFromToolsets,
  withApproval,
} from './tools.js';
import {
  compactContextIfNeeded,
  estimateAgentMessagesTokens,
  estimateTextTokens,
  getContextCompactionMaxTokens,
  truncateToolResults,
} from './agent-runner/context-compaction.js';
import { buildToolResultPreview, persistToolResult } from './agent-runner/tool-result-persistence.js';
import { createWebProvider, type WebProvider } from './web/index.js';
import { runIntrospection } from './introspection/index.js';
import { loadSkillIndex } from './skills.js';
import type { ScheduleRecord } from '@openhermit/store';
import { McpClientManager } from './mcp-client.js';
import { createMcpManagementToolset, createMcpStatusOnlyToolset } from './tools/mcp.js';
import {
  agentErrorsTotal,
  agentMessagesTotal,
  agentTokensTotal,
  agentToolCallsTotal,
  agentTurnDuration,
  agentTurnsTotal,
} from './metrics.js';

const addUserIdToList = (existing: string[], userId: string | undefined): string[] => {
  if (!userId) return existing;
  return existing.includes(userId) ? existing : [...existing, userId];
};

export class AgentRunner implements SessionRuntime {
  readonly events = new SessionEventBroker();
  /** Per-agent typed event bus — subscribed to by future plugins. */
  readonly bus = new AgentEventBus();
  readonly security: import('./core/index.js').AgentSecurity;
  readonly workspace: import('./core/index.js').AgentWorkspace;

  private readonly containerManager: DockerContainerManager;

  private execBackendManager: ExecBackendManager | undefined;

  private readonly store: InternalStateStore;

  private readonly scope: StoreScope;

  private readonly sessions = new Map<string, RunnerSession>();

  /** Channel outbound adapters registered after startup (keyed by channel name). */
  private readonly channelOutbound = new Map<string, import('@openhermit/protocol').ChannelOutbound>();

  private workspaceIdleTimer: ReturnType<typeof setTimeout> | undefined;

  private staleSessionTimer: ReturnType<typeof setInterval> | undefined;
  private mcpClientManager: McpClientManager | undefined;

  private static DEBUG = false;

  private logRuntime(message: string): void {
    console.log(`[openhermit-agent] [${this.scope.agentId}] ${message}`);
  }

  private logDebug(message: string): void {
    if (AgentRunner.DEBUG) {
      console.log(`[openhermit-debug] ${message}`);
    }
  }

  private constructor(
    private readonly options: AgentRunnerOptions,
    store: InternalStateStore,
  ) {
    this.store = store;
    this.security = options.security;
    this.workspace = options.workspace;
    this.scope = { agentId: options.security.agentId };
    this.containerManager =
      options.containerManager
      ?? new DockerContainerManager(options.workspace, {
        agentId: options.security.agentId,
      });
  }

  static async create(options: AgentRunnerOptions): Promise<AgentRunner> {
    AgentRunner.DEBUG = Boolean(process.env.OPENHERMIT_DEBUG);
    const store = options.store
      ?? await DbInternalStateStore.open();
    const runner = new AgentRunner(options, store);
    await runner.bus.emit('agent.started@v1', {
      agentId: runner.scope.agentId,
      at: new Date().toISOString(),
    });
    return runner;
  }

  /**
   * Start the periodic stale-session sweep. Scheduling itself lives in
   * the gateway-level central scheduler (see
   * `apps/gateway/src/central-scheduler.ts`); the runner only exposes
   * `runScheduledJob` so the central scheduler can drive a fire.
   */
  startBackgroundTimers(): void {
    void this.markStaleSessions();
    const ONE_DAY_MS = 24 * 60 * 60 * 1000;
    this.staleSessionTimer = setInterval(() => void this.markStaleSessions(), ONE_DAY_MS);
    this.staleSessionTimer.unref?.();
  }

  /**
   * Fire a single scheduled job. Called by the central scheduler. The
   * caller owns row bookkeeping (`startRun` / `markRun` / `finishRun`);
   * this method only opens the session, runs the prompt, and tears the
   * session down for one-off schedules.
   */
  async runScheduledJob(schedule: ScheduleRecord, sessionId: string): Promise<void> {
    await this.openSession({
      sessionId,
      source: { kind: 'schedule', interactive: false },
      ...(schedule.createdBy ? { metadata: { schedule_user_id: schedule.createdBy } } : {}),
    });

    let prompt = schedule.prompt;
    if (schedule.delivery.kind === 'session' && schedule.delivery.sessionId) {
      prompt += `\n\n[Delivery] After completing the task, if necessary, use session_send to send the result to session "${schedule.delivery.sessionId}".`;
    }

    // Plugins may rewrite the prompt via the schedule.fired@v1 transform.
    const transformed = await this.bus.transform('schedule.fired@v1', {
      agentId: this.scope.agentId,
      scheduleId: schedule.scheduleId,
      type: schedule.type,
      prompt,
      sessionId,
    });

    const metadata = {
      schedule_id: schedule.scheduleId,
      schedule_type: schedule.type,
    };
    await this.postMessage(sessionId, { text: transformed.prompt, metadata });

    if (schedule.type === 'once') {
      const session = this.sessions.get(sessionId);
      if (session) {
        session.status = 'inactive';
        this.clearIdleSummaryTimer(session);
        this.persistSessionIndex(session);
        this.sessions.delete(sessionId);
      } else {
        await this.store.sessions.updateStatus(this.scope, sessionId, 'inactive');
      }
      await this.bus.emit('session.closed@v1', {
        agentId: this.scope.agentId,
        sessionId,
        reason: 'idle',
      });
    }
  }

  /**
   * Disconnect any active MCP clients and reconnect against the current
   * enabled list. Called after admin actions that change MCP assignments
   * (including wildcard `agent_id = '*'` assignments) so running agents
   * pick up changes without a restart. If MCP has not been initialized
   * yet (no session has run), this is a no-op — the next session will
   * connect lazily against the fresh list.
   */
  async reloadMcpServers(): Promise<void> {
    if (!this.options.mcpServerStore) return;
    if (this.mcpClientManager) {
      await this.mcpClientManager.disconnectAll();
      this.mcpClientManager = undefined;
    }
    const mcpServers = await this.options.mcpServerStore.listEnabled(this.scope.agentId);
    if (mcpServers.length > 0) {
      this.mcpClientManager = new McpClientManager();
      this.mcpClientManager.connectAll(mcpServers);
    }
    this.logRuntime(`mcp: reloading (${mcpServers.length} server(s) enabled, connecting in background)`);
  }

  /** Register a channel outbound adapter (called after channel startup). */
  registerChannelOutbound(adapter: import('@openhermit/protocol').ChannelOutbound): void {
    this.channelOutbound.set(adapter.channel, adapter);
    this.logRuntime(`registered channel outbound: ${adapter.channel}`);
  }

  /** Get all registered channel outbound adapters. */
  getChannelOutbound(): Map<string, import('@openhermit/protocol').ChannelOutbound> {
    return this.channelOutbound;
  }

  /**
   * Load sandbox rows from the store and build the manager from them.
   * Falls back to legacy `config.exec.backends[]` when no rows exist
   * (e.g. mid-backfill or sandbox store unavailable).
   */
  private async ensureExecBackendManager(config: AgentConfig): Promise<ExecBackendManager> {
    if (this.execBackendManager) return this.execBackendManager;

    const ctxBase = {
      containerManager: this.containerManager,
      agentId: this.scope.agentId,
      workspaceDir: this.options.workspace.root,
      passThroughEnvProvider: () => this.options.security.getPassThroughEnv(),
    };

    if (this.options.sandboxStore) {
      const rows = await this.options.sandboxStore.listByAgent(this.scope.agentId);
      if (rows.length > 0) {
        const store = this.options.sandboxStore;
        this.execBackendManager = ExecBackendManager.fromSandboxRows(rows, ctxBase, {
          getRuntimeState: async (sandboxId) => {
            const row = await store.get(sandboxId);
            return row?.runtimeState ?? null;
          },
          setRuntimeState: async (sandboxId, state) => {
            await store.update(sandboxId, { runtimeState: state });
          },
          markActive: async (sandboxId, patch) => {
            const next: Parameters<typeof store.update>[1] = { status: 'provisioned' };
            if (patch.externalId !== undefined) next.externalId = patch.externalId;
            if (patch.lastSeenAt !== undefined) next.lastSeenAt = patch.lastSeenAt;
            await store.update(sandboxId, next);
          },
        });
        return this.execBackendManager;
      }
    }

    this.execBackendManager = ExecBackendManager.fromConfig(config.exec, ctxBase);
    return this.execBackendManager;
  }

  resetWorkspaceIdleTimer(lifecycle: import('./core/types.js').WorkspaceContainerLifecycle | undefined): void {
    if (this.workspaceIdleTimer) {
      clearTimeout(this.workspaceIdleTimer);
      this.workspaceIdleTimer = undefined;
    }

    const stopPolicy = lifecycle?.stop ?? 'idle';

    if (stopPolicy !== 'idle') {
      return;
    }

    const timeoutMs = (lifecycle?.idle_timeout_minutes ?? 30) * 60_000;

    this.workspaceIdleTimer = setTimeout(() => {
      this.workspaceIdleTimer = undefined;
      // Route through ExecBackendManager so each backend's shutdown() runs
      // (sandbox row status flips to 'stopped', etc.). When the manager
      // hasn't been constructed yet, there's nothing running to stop.
      const manager = this.execBackendManager;
      if (!manager) return;
      void manager
        .shutdownAll()
        .then(() => this.logRuntime('exec backends shut down (idle timeout)'))
        .catch(() => {});
    }, timeoutMs);
  }

  /**
   * Push the agent's enabled skill set into every configured exec backend.
   * For docker the skills land in the bind-mount; for host they go to $HOME;
   * for e2b they're streamed via the SDK if the sandbox is connected.
   */
  async syncSkills(skills: import('./core/exec-backend.js').SyncSkillEntry[]): Promise<void> {
    const config = await this.options.security.readConfig();
    const manager = await this.ensureExecBackendManager(config);
    await manager.syncSkills(skills);
  }

  async stopWorkspaceContainerIfSessionPolicy(): Promise<void> {
    const config = await this.options.security.readConfig();

    if (this.workspaceIdleTimer) {
      clearTimeout(this.workspaceIdleTimer);
      this.workspaceIdleTimer = undefined;
    }

    if (
      (config.exec?.lifecycle?.stop ?? 'idle') === 'session'
    ) {
      if (this.execBackendManager) {
        await this.execBackendManager.shutdownAll();
        this.logRuntime('exec backends shut down (session end)');
      }
    }
  }

  /** Stop workspace container, scheduler, and clean up exec backend state. */
  async shutdown(): Promise<void> {
    // Fire session.closed@v1 for every still-active session before tearing
    // down. Plugins can use this to flush session-scoped state.
    for (const sessionId of [...this.sessions.keys()]) {
      try {
        await this.bus.emit('session.closed@v1', {
          agentId: this.scope.agentId,
          sessionId,
          reason: 'shutdown',
        });
      } catch (err) {
        this.logRuntime(`session.closed hook error for ${sessionId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (this.staleSessionTimer) {
      clearInterval(this.staleSessionTimer);
      this.staleSessionTimer = undefined;
    }

    if (this.workspaceIdleTimer) {
      clearTimeout(this.workspaceIdleTimer);
      this.workspaceIdleTimer = undefined;
    }

    if (this.mcpClientManager) {
      await this.mcpClientManager.disconnectAll();
      this.mcpClientManager = undefined;
    }

    if (this.execBackendManager) {
      await this.execBackendManager.shutdownAll();
      this.execBackendManager = undefined;
    }

    await this.bus.emit('agent.stopped@v1', {
      agentId: this.scope.agentId,
      at: new Date().toISOString(),
    });
  }

  private static STALE_SESSION_DAYS = 3;

  private async markStaleSessions(): Promise<void> {
    try {
      const cutoff = new Date(Date.now() - AgentRunner.STALE_SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString();
      const count = await this.store.sessions.markStaleInactive(this.scope, cutoff);
      if (count > 0) {
        this.logRuntime(`marked ${count} stale session(s) as inactive (no activity for ${AgentRunner.STALE_SESSION_DAYS}+ days)`);
      }
    } catch (error) {
      this.logRuntime(`failed to mark stale sessions: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async openSession(spec: SessionSpec, caller?: Caller): Promise<SessionDescriptor> {
    const existing = this.sessions.get(spec.sessionId);
    const now = new Date().toISOString();

    if (existing) {
      this.clearIdleSummaryTimer(existing);
      const mergedMetadata = {
        ...(existing.spec.metadata ?? {}),
        ...(spec.metadata ?? {}),
      };

      existing.spec = {
        ...existing.spec,
        ...spec,
        // Preserve the original source — reopening from a different channel
        // (e.g. viewing a telegram session in the web UI) must not change it.
        source: existing.spec.source,
        ...(Object.keys(mergedMetadata).length > 0
          ? { metadata: mergedMetadata }
          : {}),
      };
      existing.status = 'idle';

      // Re-resolve user identity every time the session opens. This picks
      // up merges and explicit /api/users + /members registrations that
      // happened since the session was first created.
      const { userId, role, userName, channel: reChannel, channelUserId: reChannelUserId } = await this.resolveSessionUser(existing.spec, now, caller);

      // Access control: only allow reopen if the resolved user is already
      // a participant or is the owner.  Don't silently add strangers.
      if (userId && !existing.userIds.includes(userId) && role !== 'owner') {
        throw new NotFoundError(`Session not found: ${spec.sessionId}`);
      }

      if (userId) existing.resolvedUserId = userId;
      if (role) existing.resolvedUserRole = role;
      if (userName) existing.resolvedUserName = userName;
      if (reChannel) existing.resolvedChannel = reChannel;
      if (reChannelUserId) existing.resolvedChannelUserId = reChannelUserId;
      // Don't add the reopener to user_ids. That list is the
      // canonical participant set (for direct: the original speaker;
      // for group: everyone who has sent a message). Reviewing a
      // session — even by owner via the role-override above — must
      // not silently promote the reviewer to a participant.

      await this.persistSessionIndex(existing);

      return {
        spec: existing.spec,
        createdAt: existing.createdAt,
        updatedAt: existing.updatedAt,
      };
    }

    const persisted = await this.store.sessions.get(this.scope,spec.sessionId);
    const mergedMetadata = {
      ...(persisted?.metadata ?? {}),
      ...(spec.metadata ?? {}),
    };
    // customInstruction is set ONCE at session creation. On reopen the
    // persisted row is authoritative — even if it stored no instruction,
    // we must not let a later spec inject one (immutability).
    const effectiveCustomInstruction = persisted
      ? persisted.customInstruction
      : spec.customInstruction;
    const effectiveSpec: SessionSpec = {
      ...spec,
      source: persisted?.source ?? spec.source,
      ...(Object.keys(mergedMetadata).length > 0
        ? { metadata: mergedMetadata }
        : {}),
      ...(effectiveCustomInstruction
        ? { customInstruction: effectiveCustomInstruction }
        : {}),
    };
    const createdAt = persisted?.createdAt ?? now;

    const config = await this.options.security.readConfig();

    // Resolve user identity for this session. CLI/web users are
    // expected to have been registered via /api/users + /api/agents/:id/members
    // before opening a session; channel adapters still auto-create their
    // per-channel guest users via resolveSessionUser when sender info is in
    // the spec metadata.
    const {
      userId: resolvedUserId,
      role: resolvedUserRole,
      userName: resolvedUserName,
      channel: resolvedChannel,
      channelUserId: resolvedChannelUserId,
    } = await this.resolveSessionUser(effectiveSpec, now, caller);

    // Access control on reopen: non-owner users must already be participants
    if (persisted && resolvedUserId && !persisted.userIds?.includes(resolvedUserId) && resolvedUserRole !== 'owner') {
      throw new NotFoundError(`Session not found: ${spec.sessionId}`);
    }

    // Access control on new session: protected/private agents reject any
    // sender that didn't resolve to a known user with a membership row.
    // resolveSessionUser already logged the reason; here we turn that into
    // a hard reject so no session/message is processed for them.
    if (!resolvedUserId && this.options.security.getAccessLevel() !== 'public') {
      throw new NotFoundError(`Session not found: ${spec.sessionId}`);
    }

    if (
      (config.exec?.lifecycle?.start ?? 'ondemand') === 'session'
    ) {
      const manager = await this.ensureExecBackendManager(config);
      await manager.getDefault().ensure();
      this.logRuntime(`exec backend ensured for agent ${this.scope.agentId}`);
    }

    const approvalGate = new ApprovalGate();
    const approvedCache = new Set<string>();
    const isOwnerInteractive = effectiveSpec.source.interactive && resolvedUserRole === 'owner';
    const approvalCallback = isOwnerInteractive
      ? this.makeApprovalCallback(effectiveSpec.sessionId, approvalGate)
      : undefined;
    const langfuseTurnContext: LangfuseTurnContext | undefined =
      this.options.langfuse ? { currentTrace: undefined } : undefined;
    let session: RunnerSession | undefined;
    const agent = await this.createAgent(
      effectiveSpec,
      config,
      approvalCallback,
      (...args) => {
        if (!session) {
          throw new Error('Session was not initialized before tool call.');
        }

        return this.makeToolCallCallback(session)(...args);
      },
      approvedCache,
      langfuseTurnContext,
      resolvedUserRole,
      resolvedUserId,
      resolvedUserName,
      resolvedChannel,
      resolvedChannelUserId,
    );
    session = {
      spec: effectiveSpec,
      createdAt,
      updatedAt: persisted?.lastActivityAt ?? now,
      agent,
      queue: Promise.resolve(),
      sideEffects: Promise.resolve(),
      backgroundTasks: Promise.resolve(),
      checkpointInProgress: false,
      idleSummaryTimer: undefined,
      latestAssistantText: undefined,
      approvalGate,
      status: 'idle',
      messageCount: persisted?.messageCount ?? 0,
      completedTurnCount: persisted?.completedTurnCount ?? 0,
      ...(persisted?.description ? { description: persisted.description } : {}),
      ...(persisted?.descriptionSource
        ? { descriptionSource: persisted.descriptionSource }
        : {}),
      ...(persisted?.lastMessagePreview
        ? { lastMessagePreview: persisted.lastMessagePreview }
        : {}),
      resumed: Boolean(persisted),
      userIds: addUserIdToList(persisted?.userIds ?? [], resolvedUserId),
      ...(resolvedUserId ? { resolvedUserId } : {}),
      ...(resolvedUserRole ? { resolvedUserRole } : {}),
      ...(resolvedUserName ? { resolvedUserName } : {}),
      ...(resolvedChannel ? { resolvedChannel } : {}),
      ...(resolvedChannelUserId ? { resolvedChannelUserId } : {}),
      ...(langfuseTurnContext ? { langfuseTurnContext } : {}),
    };

    agent.subscribe((event) => {
      this.handleAgentEvent(session, event);
    });

    this.sessions.set(spec.sessionId, session);
    await this.persistSessionIndex(session);
    if (!persisted) {
      await this.store.messages.writeSessionStarted(this.scope,effectiveSpec, {
        provider: config.model.provider,
        model: config.model.model,
      });
    }
    this.logRuntime(`session opened: ${effectiveSpec.sessionId}`);

    await this.bus.emit('session.opened@v1', {
      agentId: this.scope.agentId,
      sessionId: effectiveSpec.sessionId,
      sessionType: effectiveSpec.source.type ?? 'direct',
      sourceKind: effectiveSpec.source.kind,
      ...(effectiveSpec.source.platform ? { sourcePlatform: effectiveSpec.source.platform } : {}),
      participants: session.userIds,
    });

    return {
      spec: session.spec,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    };
  }

  async listSessions(query: SessionListQuery = {}, callerUserId?: string): Promise<SessionSummary[]> {
    const persistedSessions = await this.store.sessions.list(
      this.scope,
      {
        ...(callerUserId ? { userId: callerUserId } : {}),
        ...(query.includeInactive ? { includeInactive: true } : {}),
      },
    );
    const limit = query.limit;
    // DB is the single source of truth for the session list. The
    // in-memory map only holds runtime handles (Agent instance, queue,
    // timers); summary fields (source, metadata, counters, status,
    // description, preview) all come from the persisted row.
    const summaries = buildSessionSummaries(
      persistedSessions,
      query,
      (sessionId) => this.events.getBacklog(sessionId).at(-1)?.id ?? 0,
    );

    return limit !== undefined ? summaries.slice(0, limit) : summaries;
  }

  /** Verify that callerUserId is a participant of the session (or an owner). Throws NotFoundError if not. */
  async verifySessionAccess(sessionId: string, callerUserId: string): Promise<void> {
    const role = await this.store.users.getAgentRole(this.scope, callerUserId);
    if (role === 'owner') return;

    const persisted = await this.store.sessions.get(this.scope, sessionId);
    if (!persisted || !persisted.userIds?.includes(callerUserId)) {
      throw new NotFoundError(`Session not found: ${sessionId}`);
    }
  }

  async deleteSession(sessionId: string, callerUserId?: string): Promise<void> {
    if (callerUserId) {
      await this.verifySessionAccess(sessionId, callerUserId);
    }
    const persisted = await this.store.sessions.get(this.scope, sessionId);
    if (!persisted) throw new NotFoundError(`Session not found: ${sessionId}`);
    if (persisted.type === 'group') {
      throw new Error('Cannot delete group sessions.');
    }
    if (persisted.status === 'running') {
      throw new Error('Cannot delete a running session.');
    }
    this.sessions.delete(sessionId);
    await this.store.sessions.delete(this.scope, sessionId);
    await this.bus.emit('session.closed@v1', {
      agentId: this.scope.agentId,
      sessionId,
      reason: 'user',
    });
  }

  async listSessionMessages(sessionId: string, callerUserId?: string): Promise<SessionHistoryMessage[]> {
    // Access control: if callerUserId is set, verify participation
    if (callerUserId) {
      await this.verifySessionAccess(sessionId, callerUserId);
    }

    const activeSession = this.sessions.get(sessionId);

    if (activeSession) {
      await activeSession.sideEffects;
      return this.store.messages.listHistoryMessages(this.scope,activeSession.spec.sessionId);
    }

    const persisted = await this.store.sessions.get(this.scope,sessionId);

    if (!persisted) {
      throw new NotFoundError(`Session not found: ${sessionId}`);
    }

    return this.store.messages.listHistoryMessages(this.scope,persisted.sessionId);
  }

  /**
   * Resolve a pending tool approval for the given session.
   * Called by the HTTP `POST /sessions/:id/approve` endpoint.
   * Returns true if a pending approval was found and resolved, false otherwise.
   */
  respondToApproval(
    sessionId: string,
    toolCallId: string,
    approved: boolean,
  ): boolean {
    const session = this.sessions.get(sessionId);

    if (!session) {
      return false;
    }

    return session.approvalGate.respond(toolCallId, approved);
  }

  async checkpointSession(
    sessionId: string,
    reason: 'manual' | 'new_session' | 'turn_limit' | 'idle' = 'manual',
  ): Promise<boolean> {
    const session = this.getRequiredSession(sessionId);
    const result = await this.runSessionCheckpoint(session, reason);

    // When a channel starts a new session (/new), mark the old one as inactive
    // so it no longer shows up in default session listings.
    if (reason === 'new_session') {
      session.status = 'inactive';
      this.persistSessionIndex(session);
    }

    return result;
  }

  async waitForSessionIdle(sessionId: string): Promise<void> {
    const session = this.getRequiredSession(sessionId);
    await session.queue;
    await session.sideEffects;
    await session.backgroundTasks;
    await this.store.sessions.waitForIdle();
  }

  private getIdleSummaryTimeoutMs(config?: AgentConfig): number {
    const introspection = config?.memory.introspection;
    if (introspection?.enabled && introspection.idle_timeout_minutes > 0) {
      return introspection.idle_timeout_minutes * 60_000;
    }
    return DEFAULT_INTROSPECTION_CONFIG.idle_timeout_minutes * 60_000;
  }

  private getCheckpointTurnInterval(config?: AgentConfig): number {
    const introspection = config?.memory.introspection;
    if (introspection?.enabled && introspection.turn_interval > 0) {
      return introspection.turn_interval;
    }
    return DEFAULT_INTROSPECTION_CONFIG.turn_interval;
  }

  private getPassiveTurnInterval(config?: AgentConfig): number {
    const introspection = config?.memory.introspection;
    if (introspection?.enabled && introspection.passive_turn_interval > 0) {
      return introspection.passive_turn_interval;
    }
    return DEFAULT_INTROSPECTION_CONFIG.passive_turn_interval;
  }

  private clearIdleSummaryTimer(session: RunnerSession): void {
    if (!session.idleSummaryTimer) {
      return;
    }

    clearTimeout(session.idleSummaryTimer);
    session.idleSummaryTimer = undefined;
  }

  private scheduleIdleSummary(session: RunnerSession): void {
    this.clearIdleSummaryTimer(session);
    session.idleSummaryTimer = setTimeout(() => {
      void this.queueBackgroundTask(session, async () => {
        await this.runSessionCheckpoint(session, 'idle');
      });
    }, this.getIdleSummaryTimeoutMs());
    session.idleSummaryTimer.unref?.();
  }

  private async runSessionCheckpoint(
    session: RunnerSession,
    reason: 'manual' | 'new_session' | 'turn_limit' | 'idle',
  ): Promise<boolean> {
    if (session.checkpointInProgress) {
      return false;
    }

    session.checkpointInProgress = true;

    try {
      await session.queue;
      await session.sideEffects;

      const lastIntrospectionEventId = await this.store.messages.getLastIntrospectionEventId(
        this.scope,
        session.spec.sessionId,
      );

      const unsummarized = await this.store.messages.listMessagesSinceEvent(
        this.scope,
        session.spec.sessionId,
        lastIntrospectionEventId,
      );

      if (unsummarized.length === 0) {
        return false;
      }

      const latestEventId = await this.store.messages.getLatestEventId(
        this.scope,
        session.spec.sessionId,
      );

      const config = await this.options.security.readConfig();
      // Skip introspection silently if the configured provider has no
      // API key available — pi-agent-core's stream loop runs in an
      // un-awaited IIFE, so a thrown "No API key" rejects nowhere and
      // would crash the process.
      if (!this.resolveApiKey(config.model.provider)) {
        this.logRuntime(`introspection skipped: no API key for provider "${config.model.provider}"`);
        return false;
      }
      return await this.runIntrospection(session, reason, config, latestEventId, unsummarized);
    } finally {
      session.checkpointInProgress = false;
    }
  }

  private async runIntrospection(
    session: RunnerSession,
    reason: 'manual' | 'new_session' | 'turn_limit' | 'idle',
    config: AgentConfig,
    latestEventId: number,
    newHistory: Array<{ role: 'user' | 'assistant' | 'error'; content: string; ts: string }>,
  ): Promise<boolean> {
    const previousWorkingMemory = await this.store.messages.getSessionWorkingMemory(this.scope,
      session.spec.sessionId,
    );

    const result = await runIntrospection({
      reason,
      sessionId: session.spec.sessionId,
      config,
      store: this.store,
      scope: this.scope,
      security: this.options.security,
      history: newHistory,
      previousWorkingMemory,
      currentDescription: session.description,
      createAgent: (input) => this.createConfiguredAgent(input),
      ...(this.options.langfuse ? { langfuse: this.options.langfuse } : {}),
      logRuntime: (msg) => this.logRuntime(msg),
    });

    // Update session index
    const ts = new Date().toISOString();

    // Sync description back from store if introspection updated it
    if (result.descriptionUpdated) {
      const persisted = await this.store.sessions.get(this.scope, session.spec.sessionId);
      if (persisted?.description) {
        session.description = persisted.description;
        session.descriptionSource = 'ai';
      }
    }

    await this.persistSessionIndex(session);

    this.logRuntime(`introspection: ${reason} — ${result.toolCallCount} tool calls, success=${result.success}`);

    return result.success;
  }

  async postMessage(
    sessionId: string,
    message: SessionMessage,
  ): Promise<{ sessionId: string; messageId?: string; triggered: boolean }> {
    const session = this.getRequiredSession(sessionId);

    // Plugin transform hook — plugins may rewrite (or scrub) the
    // incoming text before it lands in the session log.
    const transformed = await this.bus.transform('session.message.received@v1', {
      agentId: this.scope.agentId,
      sessionId,
      text: message.text,
      ...(session.resolvedUserId ? { senderUserId: session.resolvedUserId } : {}),
      ...(session.resolvedUserRole ? { senderRole: session.resolvedUserRole } : {}),
      ...(message.sender?.channel ? { senderChannel: message.sender.channel } : {}),
    });
    if (transformed.text !== message.text) {
      message = { ...message, text: transformed.text };
    }

    // If this message arrived via a channel adapter, additionally fire
    // channel.message.in@v1 so channel-specific plugins (e.g. Slack
    // signature filtering, Telegram /command parsing) can transform it.
    if (session.spec.source.kind === 'channel' && session.spec.source.platform) {
      const channelTransformed = await this.bus.transform('channel.message.in@v1', {
        agentId: this.scope.agentId,
        sessionId,
        channel: session.spec.source.platform,
        direction: 'in',
        text: message.text,
        ...(message.metadata ? { metadata: message.metadata } : {}),
      });
      if (channelTransformed.text !== message.text) {
        message = { ...message, text: channelTransformed.text };
      }
    }

    this.clearIdleSummaryTimer(session);
    session.updatedAt = new Date().toISOString();
    session.status = 'running';
    session.messageCount += 1;
    session.lastUserMessageText = message.text;
    if (!session.description) {
      const fallbackDescription = createFallbackDescription(message.text);

      if (fallbackDescription) {
        session.description = fallbackDescription;
        session.descriptionSource = 'fallback';
      }
    }
    session.lastMessagePreview = message.text;

    // Per-message sender resolution (for group sessions or any message with sender info)
    let messageUserId = session.resolvedUserId;
    if (message.sender) {
      const now = new Date().toISOString();
      const resolved = await this.resolveMessageSender(message.sender, now);
      if (resolved.userId) {
        messageUserId = resolved.userId;
        // Update session's current user so system prompt reflects the latest sender
        session.resolvedUserId = resolved.userId;
        if (resolved.role) session.resolvedUserRole = resolved.role;
        if (resolved.userName) session.resolvedUserName = resolved.userName;
        session.userIds = addUserIdToList(session.userIds, resolved.userId);
      }
    }

    await this.persistSessionIndex(session);

    const receivedAt = new Date().toISOString();
    const messageUserName = session.resolvedUserName;
    await this.queueSideEffect(session, async () => {
      await this.store.messages.appendLogEntry(this.scope, session.spec.sessionId, {
        ts: receivedAt,
        role: 'user',
        messageId: message.messageId,
        content: message.text,
        ...(message.attachments ? { attachments: message.attachments } : {}),
        ...(messageUserId ? { userId: messageUserId } : {}),
        ...(messageUserName ? { userName: messageUserName } : {}),
        ...(message.metadata ? { metadata: message.metadata } : {}),
      });
    });

    void this.events.publish({
      type: 'user_message',
      sessionId,
      text: message.text,
      ...(messageUserName ? { name: messageUserName } : {}),
    });

    agentMessagesTotal.inc({
      agent_id: this.scope.agentId,
      source: session.spec.source.kind,
    });

    // Determine whether to trigger an agent response
    const isGroup = session.spec.source.type === 'group';
    const mentioned = message.mentioned !== false;

    // Group + not mentioned → store only, don't trigger agent
    if (isGroup && !mentioned) {
      session.status = 'idle';
      void this.queueBackgroundTask(session, async () => {
        const config = await this.options.security.readConfig();
        const passiveInterval = this.getPassiveTurnInterval(config);
        const userMsgCount = await this.store.messages.getUserMessagesSinceLastIntrospection(
          this.scope, sessionId,
        );
        if (userMsgCount >= passiveInterval) {
          await this.runSessionCheckpoint(session, 'idle');
        }
      });
      return { sessionId, ...(message.messageId ? { messageId: message.messageId } : {}), triggered: false };
    }

    // In group sessions, prefix the message with the sender's display name
    const promptText = isGroup && message.sender?.displayName
      ? `[${message.sender.displayName}] ${message.text}`
      : message.text;
    const promptMessage = { ...message, text: promptText };

    const run = async (): Promise<void> => {
      try {
        await this.refreshAgentConfiguration(session);
        session.latestAssistantText = undefined;
        if (this.options.langfuse && session.langfuseTurnContext) {
          startTurnTrace(
            this.options.langfuse,
            session.langfuseTurnContext,
            session.spec.sessionId,
            session.completedTurnCount + 1,
            message.text,
          );
        }
        session.turnStartMs = Date.now();
        await session.agent.prompt(createUserMessage(promptMessage));
      } catch (error) {
        await this.handleRunError(session, error);
      }
    };

    session.queue = session.queue.then(run, run);

    return {
      sessionId,
      ...(message.messageId ? { messageId: message.messageId } : {}),
      triggered: true,
    };
  }

  async appendMessage(
    sessionId: string,
    message: SessionMessage,
  ): Promise<void> {
    const session = this.getRequiredSession(sessionId);
    session.updatedAt = new Date().toISOString();

    let messageUserId = session.resolvedUserId;
    if (message.sender) {
      const now = new Date().toISOString();
      const resolved = await this.resolveMessageSender(message.sender, now);
      if (resolved.userId) {
        messageUserId = resolved.userId;
        session.userIds = addUserIdToList(session.userIds, resolved.userId);
      }
    }

    const receivedAt = new Date().toISOString();
    const displayName = message.sender?.displayName;
    await this.queueSideEffect(session, async () => {
      await this.store.messages.appendLogEntry(this.scope, session.spec.sessionId, {
        ts: receivedAt,
        role: 'user',
        messageId: message.messageId,
        content: message.text,
        ...(message.attachments ? { attachments: message.attachments } : {}),
        ...(messageUserId ? { userId: messageUserId } : {}),
        ...(displayName ? { userName: displayName } : {}),
        ...(message.metadata ? { metadata: message.metadata } : {}),
      });
    });

    void this.events.publish({
      type: 'user_message',
      sessionId,
      text: message.text,
      ...(displayName ? { name: displayName } : {}),
    });
  }

  private makeApprovalCallback(
    sessionId: string,
    gate: ApprovalGate,
  ): ApprovalCallback {
    return async (toolName, toolCallId, args) => {
      const session = this.sessions.get(sessionId);

      if (session) {
        await this.recordApprovalRequested(session, toolName, toolCallId, args);
      }

      await this.events.publish({
        type: 'tool_approval_required',
        sessionId,
        toolName,
        toolCallId,
        ...(args !== undefined ? { args } : {}),
      });

      if (session) {
        session.status = 'awaiting_approval';
        session.updatedAt = new Date().toISOString();
      }

      const decision = await gate.request(toolCallId);

      if (session) {
        session.status = 'running';
        session.updatedAt = new Date().toISOString();
        await this.recordApprovalResolved(session, toolName, toolCallId, decision);
      }

      return decision;
    };
  }

  private makeNotifyOwnerApproval(): ((requestId: string, shortId: number, resourceType: string, resourceKey: string, requesterId: string, requesterSessionId: string) => Promise<void>) | undefined {
    if (this.channelOutbound.size === 0) return undefined;

    return async (requestId, shortId, resourceType, resourceKey, requesterId, requesterSessionId) => {
      try {
        const config = await this.options.security.readConfig();
        const notif = config.notifications;
        if (!notif) return;

        let targetSession: import('@openhermit/store').PersistedSessionIndexEntry | undefined;

        if (notif.session_id) {
          targetSession = await this.store.sessions.get(this.scope, notif.session_id) ?? undefined;
        } else if (notif.channel) {
          const members = await this.store.users.listByAgent(this.scope);
          const ownerIds = new Set(members.filter((m) => m.role === 'owner').map((m) => m.userId));

          const allSessions = await this.store.sessions.list(this.scope, { includeInactive: false });
          const ownerSessions = allSessions
            .filter((s) =>
              s.source.platform === notif.channel
              && s.userIds?.some((uid) => ownerIds.has(uid)),
            )
            .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
          targetSession = ownerSessions[0];
        }

        if (!targetSession) return;

        void this.events.publish({
          type: 'approval_pending',
          sessionId: targetSession.sessionId,
          requestId,
          resourceType,
          resourceKey,
          requesterId,
          requesterSessionId,
          mode: 'async',
        });

        const { resolveOutbound } = await import('./tools/session.js');
        const outbound = resolveOutbound(targetSession, this.channelOutbound);
        if (!outbound) return;

        const text = `🔔 Approval required\n\n`
          + `User \`${requesterId}\` needs approval for ${resourceType}/${resourceKey}.\n`
          + `Request ID: ${requestId}`;

        await outbound.adapter.send({
          sessionId: targetSession.sessionId,
          to: outbound.to,
          text,
          actions: [{ type: 'approval_review', requestId, shortId }],
        });
      } catch {
        // Best-effort — don't break the tool call if notification fails.
      }
    };
  }

  private makeToolCallCallback(session: RunnerSession): ToolCallCallback {
    return async (toolName, toolCallId, args) => {
      const ts = new Date().toISOString();
      session.status = 'running';
      session.updatedAt = ts;

      agentToolCallsTotal.inc({ agent_id: this.scope.agentId, tool: toolName });

      await this.events.publish({
        type: 'tool_call',
        sessionId: session.spec.sessionId,
        tool: toolName,
        toolCallId,
        ...(args !== undefined ? { args } : {}),
      });

      await this.queueSideEffect(session, async () => {
        await this.store.messages.appendLogEntry(this.scope, session.spec.sessionId, {
          ts,
          role: 'tool_call',
          type: 'tool_call',
          name: toolName,
          args,
          toolCallId,
        });
      });
    };
  }

  private async recordApprovalRequested(
    session: RunnerSession,
    toolName: string,
    toolCallId: string,
    args: unknown,
  ): Promise<void> {
    const ts = new Date().toISOString();

    await this.queueSideEffect(session, async () => {
      await this.store.messages.appendLogEntry(this.scope,session.spec.sessionId, {
        ts,
        role: 'system',
        type: 'tool_approval_requested',
        toolName,
        toolCallId,
        ...(args !== undefined ? { args } : {}),
      });
    });
  }

  private async recordApprovalResolved(
    session: RunnerSession,
    toolName: string,
    toolCallId: string,
    decision: ApprovalDecision,
  ): Promise<void> {
    const ts = new Date().toISOString();

    await this.queueSideEffect(session, async () => {
      await this.store.messages.appendLogEntry(this.scope,session.spec.sessionId, {
        ts,
        role: 'system',
        type: 'tool_approval_resolved',
        toolName,
        toolCallId,
        decision,
      });
    });
  }

  /**
   * Resolve the user for a session based on channel identity.
   * If the identity is unknown, applies auto_guest policy: creates a guest user.
   * Returns the resolved userId and role, or undefined if no identity is available.
   */
  private async resolveSessionUser(
    spec: SessionSpec,
    now: string,
    caller?: Caller,
  ): Promise<{ userId?: string; role?: UserRole; userName?: string; channel?: string; channelUserId?: string }> {
    // Schedule sessions carry the creator's userId directly
    const scheduleUserId = spec.metadata?.schedule_user_id;
    if (spec.source.kind === 'schedule' && scheduleUserId) {
      const user = await this.store.users.get(String(scheduleUserId));
      if (user) {
        const role = await this.store.users.getAgentRole(this.scope, user.userId) ?? 'guest';
        return { userId: user.userId, role, ...(user.name ? { userName: user.name } : {}) };
      }
    }

    // Caller (auth context) takes priority over session metadata. This is
    // the request initiator's identity, regardless of what channel the
    // session itself was originally created from.
    const channel = caller?.channel ?? spec.source.platform ?? spec.source.kind;
    const channelUserId = caller?.channelUserId ?? this.deriveChannelUserId(spec);
    if (!channelUserId) return {};
    const callerInfo = { channel, channelUserId };

    // Try to resolve existing identity
    const existingUserId = await this.store.users.resolve(channel, channelUserId);
    if (existingUserId) {
      const user = await this.store.users.get(existingUserId);
      const explicitRole = await this.store.users.getAgentRole(this.scope, existingUserId);
      if (user) {
        // A globally-known user with no role on THIS agent is treated the
        // same as an unknown sender: gated by the agent's access level so
        // a 'protected' / 'private' agent cannot be entered just because
        // the caller signed up elsewhere on the gateway.
        if (!explicitRole) {
          const accessLevel = this.options.security.getAccessLevel();
          if (accessLevel !== 'public') {
            this.logRuntime(
              `denied known user ${existingUserId} on ${accessLevel} agent ${this.scope.agentId} — no membership row`,
            );
            return {};
          }
          // Public agent: auto-claim guest membership for the existing user
          // (no new user row, just a role on this agent).
          await this.store.users.assignAgent(this.scope, existingUserId, 'guest', now);
          return { userId: user.userId, role: 'guest', ...(user.name ? { userName: user.name } : {}), ...callerInfo };
        }
        return { userId: user.userId, role: explicitRole, ...(user.name ? { userName: user.name } : {}), ...callerInfo };
      }
    }

    // Cross-channel viewer (e.g. owner browsing a CLI session via web)
    // should not auto-create a guest in the session's channel namespace —
    // that pollutes the user table and the lookup will mismatch on next
    // visit. Just deny if the caller has no existing identity here.
    if (caller && caller.channel !== (spec.source.platform ?? spec.source.kind)) {
      return {};
    }

    // Auto-guest gating: only the `public` access level lets unknown
    // senders auto-claim a guest membership. `protected` and `private`
    // require an explicit join — the message is dropped at the runtime
    // boundary when no userId resolves.
    const accessLevel = this.options.security.getAccessLevel();
    if (accessLevel !== 'public') {
      this.logRuntime(
        `denied unknown ${channel}:${channelUserId} on ${accessLevel} agent (no auto-guest)`,
      );
      return {};
    }

    // Unknown identity on a public agent: auto-create as guest.
    const guestId = await this.generateGuestUserId();
    const meta = spec.metadata;
    const name = meta?.telegram_first_name
      ? String(meta.telegram_first_name)
      : meta?.telegram_username
        ? String(meta.telegram_username)
        : channel === 'cli'
          ? channelUserId
          : undefined;

    await this.store.users.upsert({
      userId: guestId,
      ...(name ? { name } : {}),
      createdAt: now,
      updatedAt: now,
    });
    await this.store.users.assignAgent(this.scope, guestId, 'guest', now);

    await this.store.users.linkIdentity({
      userId: guestId,
      channel,
      channelUserId,
      createdAt: now,
    });

    this.logRuntime(`auto-created guest user ${guestId} for ${channel}:${channelUserId}`);
    return { userId: guestId, role: 'guest' as const, ...(name ? { userName: name } : {}), ...callerInfo };
  }

  /**
   * Resolve a per-message sender to a user identity.
   * Used in group sessions where each message may come from a different user.
   */
  /**
   * Generate a userId for a newly auto-created guest. Prefers the bare
   * ms timestamp (clean, sortable) and only appends 24 random bits
   * when that id already exists — covering the same-millisecond
   * collision case without polluting every id with random noise.
   */
  private async generateGuestUserId(): Promise<string> {
    const base = `usr-${Date.now().toString(36)}`;
    const existing = await this.store.users.get(base);
    if (!existing) return base;
    return `${base}-${randomBytes(3).toString('hex')}`;
  }

  private async resolveMessageSender(
    sender: MessageSender,
    now: string,
  ): Promise<{ userId?: string; role?: UserRole; userName?: string }> {
    const existingUserId = await this.store.users.resolve(
      sender.channel, sender.channelUserId,
    );
    if (existingUserId) {
      const user = await this.store.users.get(existingUserId);
      const role = await this.store.users.getAgentRole(this.scope, existingUserId) ?? 'guest';
      if (user) {
        return { userId: user.userId, role, ...(user.name ? { userName: user.name } : {}) };
      }
    }

    // Auto-create guest for unknown sender. Use the ms timestamp as the
    // base id and only fall back to a random suffix if it collides with
    // an existing row, so ids stay clean and time-sortable for the
    // common case.
    const guestId = await this.generateGuestUserId();
    await this.store.users.upsert({
      userId: guestId,
      ...(sender.displayName ? { name: sender.displayName } : {}),
      createdAt: now,
      updatedAt: now,
    });
    await this.store.users.assignAgent(this.scope, guestId, 'guest', now);
    await this.store.users.linkIdentity({
      userId: guestId,
      channel: sender.channel,
      channelUserId: sender.channelUserId,
      createdAt: now,
    });
    this.logRuntime(`auto-created guest user ${guestId} for ${sender.channel}:${sender.channelUserId}`);
    return { userId: guestId, role: 'guest' as const, ...(sender.displayName ? { userName: sender.displayName } : {}) };
  }

  /**
   * Resolve a CallerIdentity to an internal userId (read-only, no auto-creation).
   * Used by WS handlers to scope session.list / session.history before any
   * session is opened.  Returns undefined if the identity is unknown.
   */
  async resolveCallerUserId(
    caller: { channel: string; channelUserId: string },
  ): Promise<string | undefined> {
    return this.store.users.resolve(caller.channel, caller.channelUserId);
  }

  async updateUserName(
    caller: { channel: string; channelUserId: string },
    name: string,
  ): Promise<void> {
    const userId = await this.store.users.resolve(caller.channel, caller.channelUserId);
    if (!userId) return;
    const user = await this.store.users.get(userId);
    if (user) {
      await this.store.users.upsert({ ...user, name });
    }
  }

  async resolveCallerRole(
    caller: { channel: string; channelUserId: string },
  ): Promise<UserRole | undefined> {
    const userId = await this.store.users.resolve(caller.channel, caller.channelUserId);
    if (!userId) return undefined;
    return this.store.users.getAgentRole(this.scope, userId) ?? 'guest';
  }

  /**
   * Ensure a user record exists for this channel identity. Returns the
   * resolved userId, role on this agent, and whether the record was newly
   * created. CLI users go through ensureCliUser at session-open time; this
   * method is the analog for HTTP/WS auth (web devices), called from the
   * JWT exchange so a userId is available immediately on first connect.
   */
  async ensureUserForCaller(
    caller: { channel: string; channelUserId: string },
    displayName?: string,
  ): Promise<{ userId: string; role: UserRole | undefined; created: boolean }> {
    const existingUserId = await this.store.users.resolve(caller.channel, caller.channelUserId);
    if (existingUserId) {
      const role = await this.store.users.getAgentRole(this.scope, existingUserId);
      return { userId: existingUserId, role, created: false };
    }
    // Auto-create as guest. Owner promotion is always explicit (web admin
    // UI / CLI claim flow), never silent.
    const now = new Date().toISOString();
    const userId = await this.generateGuestUserId();
    await this.store.users.upsert({
      userId,
      ...(displayName ? { name: displayName } : {}),
      createdAt: now,
      updatedAt: now,
    });
    await this.store.users.assignAgent(this.scope, userId, 'guest', now);
    await this.store.users.linkIdentity({
      userId,
      channel: caller.channel,
      channelUserId: caller.channelUserId,
      createdAt: now,
    });
    this.logRuntime(`auto-created guest user ${userId} for ${caller.channel}:${caller.channelUserId} on agent ${this.scope.agentId}`);
    return { userId, role: 'guest', created: true };
  }

  /**
   * Derive a channel user ID from a session spec's metadata and source.
   * Returns undefined if no identity can be extracted.
   */
  private deriveChannelUserId(spec: SessionSpec): string | undefined {
    // Group sessions resolve users per-message, not per-session
    if (spec.source.type === 'group') return undefined;

    const meta = spec.metadata;

    // Telegram: prefer user_id (from.id), fall back to chat_id (equals user id in DMs)
    if (spec.source.platform === 'telegram') {
      if (meta?.telegram_user_id) return String(meta.telegram_user_id);
      if (meta?.telegram_chat_id) return String(meta.telegram_chat_id);
      if (meta?.telegram_username) return String(meta.telegram_username);
    }

    // CLI without a caller (e.g. CLI process running locally with no auth):
    // fall back to the OS username so first-run provisioning still works.
    if (spec.source.kind === 'cli') {
      try {
        return userInfo().username;
      } catch {
        return undefined;
      }
    }

    return undefined;
  }

  private async createAgent(
    spec: SessionSpec,
    config: AgentConfig,
    approvalCallback?: ApprovalCallback,
    onToolCall?: ToolCallCallback,
    approvedCache?: Set<string>,
    langfuseTurnContext?: LangfuseTurnContext,
    userRole?: UserRole,
    userId?: string,
    userName?: string,
    channel?: string,
    channelUserId?: string,
  ): Promise<Agent> {
    return this.createConfiguredAgent({
      config,
      agentSessionId: spec.sessionId,
      contextSessionId: spec.sessionId,
      ...(spec.source.interactive && approvalCallback ? { approvalCallback } : {}),
      ...(onToolCall ? { onToolCall } : {}),
      ...(approvedCache ? { approvedCache } : {}),
      ...(langfuseTurnContext ? { langfuseTurnContext } : {}),
      ...(userRole ? { userRole } : {}),
      ...(userId ? { userId } : {}),
      ...(userName ? { userName } : {}),
      ...(channel ? { channel } : {}),
      ...(channelUserId ? { channelUserId } : {}),
      ...(spec.source.type ? { sessionType: spec.source.type } : {}),
      sourceKind: spec.source.kind,
      ...(spec.customInstruction ? { customInstruction: spec.customInstruction } : {}),
    });
  }

  private async createConfiguredAgent(input: {
    config: AgentConfig;
    agentSessionId: string;
    contextSessionId: string;
    approvalCallback?: ApprovalCallback;
    approvedCache?: Set<string>;
    onToolCall?: ToolCallCallback;
    extraSystemPrompt?: string;
    tools?: any[];
    langfuseTurnContext?: LangfuseTurnContext;
    userRole?: UserRole;
    userId?: string;
    userName?: string;
    channel?: string;
    channelUserId?: string;
    sessionType?: import('@openhermit/protocol').SessionType;
    sourceKind?: string;
    customInstruction?: string;
  }): Promise<Agent> {
    const webProvider = this.resolveWebProvider(input.config);

    // Load exec backends once for this build — both the skill scanner and
    // the exec toolset reference the same manager.
    const execManager = await this.ensureExecBackendManager(input.config);

    // Role-based tool filtering:
    // - owner: all tools (memory, instructions, exec, web, sessions, user management)
    // - user: memory, exec, web, sessions (no instructions, no user management)
    // - guest (with userId): web, sessions (filtered by userId)
    // - undefined (no user resolved): web only (no sessions — can't identify caller)
    const role = input.userRole;
    const isOwnerOrUnresolved = role === 'owner';

    // When tools are provided directly (introspection, compaction), skip toolset creation
    let toolsets: Toolset[];
    let tools: any[];
    // Load skill index (DB-enabled + workspace-scanned)
    const skills = input.tools
      ? []
      : await loadSkillIndex(
          this.scope.agentId,
          this.options.workspace.root,
          this.options.skillStore,
          execManager.getDefault().agentHome,
        );

    if (input.tools) {
      toolsets = [];
      tools = input.tools;
    } else {
      toolsets = createBuiltInToolsets({
        security: this.options.security,
        memoryProvider: this.store.memories,
        messageStore: this.store.messages,
        sessionId: input.contextSessionId,
        webProvider,
        instructionStore: this.store.instructions,
        ...(input.userId ? { userStore: this.store.users } : {}),
        sessionStore: this.store.sessions,
        ...(input.userId ? { currentUserId: input.userId } : {}),
        ...(input.userRole ? { currentUserRole: input.userRole } : {}),
        ...(input.channel ? { currentChannel: input.channel } : {}),
        ...(input.channelUserId ? { currentChannelUserId: input.channelUserId } : {}),
        storeScope: this.scope,
        agentId: this.scope.agentId,
        execBackendManager: execManager,
        onExec: () => this.resetWorkspaceIdleTimer(input.config.exec?.lifecycle),
        ...(this.channelOutbound.size > 0 ? { channelOutbound: this.channelOutbound } : {}),
        scheduleStore: this.store.schedules,
        ...(this.options.policyStore ? { policyStore: this.options.policyStore } : {}),
        ...(this.options.approvalRequestStore ? { approvalRequestStore: this.options.approvalRequestStore } : {}),
        ...(input.approvalCallback ? { approvalCallback: input.approvalCallback } : {}),
        ...(input.approvedCache ? { approvedCache: input.approvedCache } : {}),
        ...(input.onToolCall ? { onToolCall: input.onToolCall } : {}),
        hookBus: this.bus,
        ...(() => { const n = this.makeNotifyOwnerApproval(); return n ? { notifyOwnerApproval: n } : {}; })(),
        publishEvent: (event: Record<string, unknown>) => {
          void this.events.publish(event as any);
        },
      });

      // Connect to enabled MCP servers and add their toolsets
      if (this.options.mcpServerStore) {
        if (!this.mcpClientManager) {
          this.mcpClientManager = new McpClientManager();
          const mcpServers = await this.options.mcpServerStore.listEnabled(this.scope.agentId);
          if (mcpServers.length > 0) {
            // Fire-and-forget: connections proceed in the background. The
            // current turn will only see tools from servers that have
            // already finished connecting; subsequent turns pick up the
            // rest as they become ready. The mcp_status tool surfaces
            // pending/failed connections so the agent can explain delays.
            this.mcpClientManager.connectAll(mcpServers);
          }
        }
        const toolHookCtx = {
          bus: this.bus,
          agentId: this.scope.agentId,
          sessionId: input.contextSessionId,
        };
        const wrapToolset = (ts: Toolset): Toolset => ({
          ...ts,
          tools: ts.tools.map((tool) =>
            withApproval(tool, this.options.security, input.approvalCallback, input.onToolCall, input.approvedCache, toolHookCtx),
          ),
        });
        for (const ts of this.mcpClientManager.getToolsets()) {
          toolsets.push(wrapToolset(ts));
        }
        if (isOwnerOrUnresolved) {
          toolsets.push(wrapToolset(createMcpManagementToolset(this.mcpClientManager, this.options.mcpServerStore, this.scope.agentId)));
        } else {
          toolsets.push(wrapToolset(createMcpStatusOnlyToolset(this.mcpClientManager)));
        }
      }

      tools = toolsFromToolsets(toolsets);
    }

    const principal = buildPrincipal(this.scope.agentId, input.userId, input.userRole);
    const policyRows: PolicyRow[] | undefined = this.options.policyStore
      ? await this.options.policyStore.list(this.scope.agentId, 'tool')
      : undefined;
    const mcpRows: PolicyRow[] | undefined = this.options.policyStore
      ? await this.options.policyStore.list(this.scope.agentId, 'mcp')
      : undefined;
    const approvalStore = this.options.approvalRequestStore;
    const agentId = this.scope.agentId;
    const userId = input.userId;
    const sessionId = input.contextSessionId;
    const notifyOwner = this.makeNotifyOwnerApproval();
    const eventBroker = this.events;

    const filteredTools = tools
      .filter((t: any) => {
        const toolMatches = resolveToolMatches(policyRows, t.name, t.policy);
        const toolDecision = evaluateAccess(principal, toolMatches);
        if (toolDecision === 'deny') return false;
        const serverId = parseMcpServerId(t.name);
        if (serverId && mcpRows) {
          const mcpMatches = resolveMcpMatches(mcpRows, serverId);
          if (mcpMatches !== undefined && evaluateAccess(principal, mcpMatches) === 'deny') return false;
        }
        return true;
      })
      .map((t: any) => {
        const toolMatches = resolveToolMatches(policyRows, t.name, t.policy);
        const toolDecision = evaluateAccess(principal, toolMatches);
        if (toolDecision !== 'require_approval') return t;

        let mcpNeedsApproval = false;
        const serverId = parseMcpServerId(t.name);
        if (serverId && mcpRows) {
          const mcpMatches = resolveMcpMatches(mcpRows, serverId);
          if (mcpMatches !== undefined && evaluateAccess(principal, mcpMatches) === 'require_approval') {
            mcpNeedsApproval = true;
          }
        }

        if (!mcpNeedsApproval && toolDecision !== 'require_approval') return t;

        return {
          ...t,
          execute: async (toolCallId: string, args: unknown, signal?: AbortSignal, onUpdate?: any) => {
            // Real-time approval: owner interactive session with ApprovalGate
            if (input.approvalCallback) {
              let requestId: string | undefined;
              if (approvalStore && userId) {
                const request = await approvalStore.create({
                  agentId,
                  sessionId: sessionId ?? 'unknown',
                  requesterId: userId,
                  resourceType: 'tool',
                  resourceKey: t.name,
                });
                requestId = request.id;
              }
              if (sessionId) {
                void eventBroker.publish({
                  type: 'approval_requested',
                  sessionId,
                  ...(requestId ? { requestId } : {}),
                  resourceType: 'tool',
                  resourceKey: t.name,
                  toolCallId,
                  mode: 'realtime',
                });
                void eventBroker.publish({
                  type: 'approval_pending',
                  sessionId,
                  ...(requestId ? { requestId } : {}),
                  resourceType: 'tool',
                  resourceKey: t.name,
                  requesterId: userId ?? 'unknown',
                  requesterSessionId: sessionId,
                  mode: 'realtime',
                });
              }
              const decision = await input.approvalCallback(t.name, toolCallId, args);
              if (requestId && approvalStore) {
                const dbDecision = decision === 'approved' ? 'approved' : 'rejected';
                approvalStore.resolve(requestId, dbDecision, userId ?? 'system', 'once').catch(() => {});
              }
              if (decision === 'rejected' || decision === 'timed_out' || decision === 'cancelled') {
                if (input.onToolCall) await input.onToolCall(t.name, toolCallId, args);
                return {
                  content: [{ type: 'text' as const, text: `Tool "${t.name}" was ${decision} by the user.` }],
                  details: { rejected: true, decision },
                };
              }
              return t.execute(toolCallId, args, signal, onUpdate);
            }

            // Async approval: create a persistent request for owner to review
            if (approvalStore && userId) {
              const resourceKey = t.name;
              const approved = await approvalStore.findApproved(agentId, userId, 'tool', resourceKey);
              if (!approved) {
                if (input.onToolCall) await input.onToolCall(t.name, toolCallId, args);
                const request = await approvalStore.create({
                  agentId,
                  sessionId: sessionId ?? 'unknown',
                  requesterId: userId,
                  resourceType: 'tool',
                  resourceKey,
                });
                if (sessionId) {
                  void eventBroker.publish({
                    type: 'approval_requested',
                    sessionId,
                    requestId: request.id,
                    resourceType: 'tool',
                    resourceKey: t.name,
                    toolCallId,
                    mode: 'async',
                  });
                }
                if (notifyOwner) {
                  notifyOwner(request.id, request.shortId, 'tool', resourceKey, userId, sessionId ?? 'unknown').catch(() => {});
                }
                return {
                  content: [{
                    type: 'text' as const,
                    text: `Access to tool "${t.name}" requires approval. `
                      + `An approval request has been created (id: ${request.id}). `
                      + `Ask the agent owner to run approval_review to approve or reject it.`,
                  }],
                  details: { requiresApproval: true, requestId: request.id },
                };
              }
            }
            return t.execute(toolCallId, args, signal, onUpdate);
          },
        };
      });

    const currentUser = input.userId && input.userRole
      ? {
          userId: input.userId,
          role: input.userRole,
          ...(input.userName ? { name: input.userName } : {}),
          ...(input.sessionType ? { sessionType: input.sessionType } : {}),
          sessionId: input.contextSessionId,
          ...(input.sourceKind ? { sourceKind: input.sourceKind } : {}),
        }
      : undefined;

    const baseSystemPrompt = await buildSystemPrompt(
      input.config,
      this.options.security,
      toolsets,
      {
        instructionStore: this.store.instructions,
        storeScope: this.scope,
      },
      currentUser,
      skills,
      {
        bus: this.bus,
        agentId: this.scope.agentId,
        sessionId: input.contextSessionId,
      },
      input.customInstruction,
    );
    const systemPrompt = input.extraSystemPrompt
      ? `${baseSystemPrompt}\n\n${input.extraSystemPrompt}`.trim()
      : baseSystemPrompt;
    const streamFn = createLangfuseTracedStreamFn(
      this.options.langfuse,
      this.options.streamFn,
      input.langfuseTurnContext ?? { currentTrace: undefined },
    );

    const resolvedModel = resolveModel(input.config);
    // When the user didn't pick a thinking level but the model is a
    // thinking-capable / thinking-only one (per pi-ai's registry), default
    // to 'medium' rather than 'off'. Sending no thinking parameter to a
    // thinking-only endpoint (deepseek-v4-pro, o1, ...) makes it reject
    // requests whose history already contains reasoning_content. Explicit
    // 'off' is still respected — the user accepted that tradeoff.
    const configuredThinking = input.config.model.thinking;
    const thinkingLevel = configuredThinking ?? (resolvedModel.reasoning ? 'medium' : 'off');

    return new Agent({
      initialState: {
        systemPrompt,
        model: resolvedModel,
        tools: filteredTools,
        thinkingLevel,
      },
      sessionId: input.agentSessionId,
      ...(streamFn ? { streamFn } : {}),
      getApiKey: (provider) => this.resolveApiKey(provider),
      transformContext: (messages, signal) =>
        this.transformContext(input.contextSessionId, messages, signal),
      transport: 'sse',
    });
  }

  private async refreshAgentConfiguration(session: RunnerSession): Promise<void> {
    await this.options.security.load();
    const config = await this.options.security.readConfig();
    this.ensureProviderApiKey(config.model.provider);

    const isOwnerInteractive = session.spec.source.interactive && session.resolvedUserRole === 'owner';
    const approvalCallback = isOwnerInteractive
      ? this.makeApprovalCallback(session.spec.sessionId, session.approvalGate)
      : undefined;

    const refreshedAgent = await this.createConfiguredAgent({
      config,
      agentSessionId: session.spec.sessionId,
      contextSessionId: session.spec.sessionId,
      ...(approvalCallback ? { approvalCallback } : {}),
      onToolCall: this.makeToolCallCallback(session),
      ...(session.resolvedUserRole ? { userRole: session.resolvedUserRole } : {}),
      ...(session.resolvedUserId ? { userId: session.resolvedUserId } : {}),
      ...(session.resolvedUserName ? { userName: session.resolvedUserName } : {}),
      ...(session.resolvedChannel ? { channel: session.resolvedChannel } : {}),
      ...(session.resolvedChannelUserId ? { channelUserId: session.resolvedChannelUserId } : {}),
      ...(session.spec.source.type ? { sessionType: session.spec.source.type } : {}),
      sourceKind: session.spec.source.kind,
      ...(session.spec.customInstruction ? { customInstruction: session.spec.customInstruction } : {}),
    });
    session.agent.state.model = resolveModel(config);
    session.agent.state.systemPrompt = refreshedAgent.state.systemPrompt;
    session.agent.state.tools = refreshedAgent.state.tools;
    session.agent.sessionId = session.spec.sessionId;
  }

  /**
   * Rebuild the real AgentMessage[] from DB entries for session resumption.
   * Produces the same message types the agent would have in memory if the
   * session had been running continuously, so compaction and LLM conversion
   * work identically to a live session.
   */
  private async buildResumptionMessages(
    sessionId: string,
    targetModel?: { provider: string; api: string; modelId: string },
  ): Promise<AgentMessage[]> {
    // Some providers (DeepSeek thinking models) reject any historical
    // tool-use assistant turn that lacks reasoning_content. When the
    // session has turns generated by other providers (e.g. Kimi via
    // OpenRouter), we fabricate a minimal placeholder so the request
    // is accepted and the conversation can continue.
    const requiresReasoningContent = targetModel?.provider === 'deepseek';
    const { compactionSummary, entries } =
      await this.store.messages.listSessionEntriesSinceLastCompaction(this.scope, sessionId);

    const messages: AgentMessage[] = [];

    // If there was a previous compaction, inject its summary as a context block.
    if (compactionSummary?.trim()) {
      messages.push({
        role: 'user',
        content: [{ type: 'text', text: `Context compaction summary (runtime-generated, read-only context):\n\n${compactionSummary.trim()}` }],
        timestamp: Date.now(),
      });
    }

    // Track the last assistant message so tool_call entries can be appended to it.
    let lastAssistant: import('@mariozechner/pi-ai').AssistantMessage | null = null;

    for (const entry of entries) {
      const ts = new Date(entry.ts).getTime() || Date.now();

      if (entry.role === 'system') continue;
      if (entry.role === 'error') continue;
      if (entry.introspection) continue;

      if (entry.role === 'user' && typeof entry.content === 'string') {
        lastAssistant = null;
        messages.push({ role: 'user', content: entry.content, timestamp: ts });
        continue;
      }

      if (entry.role === 'assistant' && typeof entry.content === 'string') {
        const content: import('@mariozechner/pi-ai').AssistantMessage['content'] = [];
        const hasThinking = typeof entry.thinking === 'string' && entry.thinking.length > 0;
        if (hasThinking) {
          const thinkingBlock: { type: 'thinking'; thinking: string; thinkingSignature?: string } = {
            type: 'thinking',
            thinking: entry.thinking as string,
          };
          if (typeof entry.thinkingSignature === 'string' && entry.thinkingSignature) {
            thinkingBlock.thinkingSignature = entry.thinkingSignature;
          }
          content.push(thinkingBlock as import('@mariozechner/pi-ai').AssistantMessage['content'][number]);
        }
        if (entry.content) {
          content.push({ type: 'text', text: entry.content });
        }
        lastAssistant = {
          role: 'assistant',
          content,
          api: 'anthropic-messages',
          provider: typeof entry.provider === 'string' ? entry.provider : 'anthropic',
          model: typeof entry.model === 'string' ? entry.model : 'unknown',
          usage: (entry.usage as import('@mariozechner/pi-ai').Usage) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: (typeof entry.stopReason === 'string' ? entry.stopReason : 'stop') as import('@mariozechner/pi-ai').StopReason,
          timestamp: ts,
        };
        messages.push(lastAssistant);
        continue;
      }

      if (entry.role === 'tool_call') {
        const toolCall: import('@mariozechner/pi-ai').ToolCall = {
          type: 'toolCall',
          id: typeof entry.toolCallId === 'string' ? entry.toolCallId : '',
          name: typeof entry.name === 'string' ? entry.name : 'unknown',
          arguments: (entry.args as Record<string, unknown>) ?? {},
        };
        if (lastAssistant) {
          lastAssistant.content.push(toolCall);
          if (lastAssistant.stopReason !== 'toolUse') {
            lastAssistant.stopReason = 'toolUse';
          }
        } else {
          // Orphan tool_call without a preceding assistant message — create one.
          lastAssistant = {
            role: 'assistant',
            content: [toolCall],
            api: 'anthropic-messages',
            provider: 'anthropic',
            model: 'unknown',
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            stopReason: 'toolUse',
            timestamp: ts,
          };
          messages.push(lastAssistant!);
        }
        continue;
      }

      if (entry.role === 'tool_result') {
        lastAssistant = null;
        let text = typeof entry.content === 'string' ? entry.content : JSON.stringify(entry.content ?? '');
        if (text.includes('requires approval') && text.includes('approval request has been created')) {
          text = `[This tool call previously required approval. The approval request has expired. `
            + `Do not retry this tool unless the user explicitly asks.]`;
        }
        messages.push({
          role: 'toolResult',
          toolCallId: typeof entry.toolCallId === 'string' ? entry.toolCallId : '',
          toolName: typeof entry.name === 'string' ? entry.name : 'unknown',
          content: [{ type: 'text', text }],
          isError: entry.isError === true,
          timestamp: ts,
        });
        continue;
      }
    }

    // Post-pass: ensure every assistant turn that ends up carrying a tool
    // call also has a thinking block with a `reasoning_content` signature,
    // so providers that mandate it (DeepSeek thinking models) don't 400 on
    // historical turns generated by other models. We have to do this after
    // the main loop because tool_call entries get appended onto an earlier
    // assistant retroactively (and the orphan-tool_call branch fabricates
    // its own assistants without thinking).
    // pi-ai's transform-messages.js converts thinking blocks to plain text
    // for any assistant whose provider/api/model don't match the active
    // model (isSameModel === false). Our resumed messages have api hardcoded
    // to 'anthropic-messages' and historical provider/model strings, so
    // thinking signatures get stripped before convertMessages can write
    // reasoning_content. When the active model needs reasoning_content, we
    // (a) inject a placeholder thinking block on assistants that have
    // tool_calls but no thinking, and (b) rewrite every assistant's
    // provider/api/model identity to match the active model so pi-ai sees
    // them as same-model and preserves the thinking blocks intact.
    if (requiresReasoningContent && targetModel) {
      for (const msg of messages) {
        if (msg.role !== 'assistant') continue;
        const hasToolCall = msg.content.some((b) => b.type === 'toolCall');
        const hasThinking = msg.content.some((b) => b.type === 'thinking');
        if (hasToolCall && !hasThinking) {
          msg.content.unshift({
            type: 'thinking',
            thinking: '(prior turn was generated by a different model; original reasoning unavailable)',
            thinkingSignature: 'reasoning_content',
          } as import('@mariozechner/pi-ai').AssistantMessage['content'][number]);
        }
        // Rewrite identity so pi-ai treats this turn as same-model and
        // doesn't strip thinking signatures during transform-messages.
        (msg as { provider?: string }).provider = targetModel.provider;
        (msg as { api?: string }).api = targetModel.api;
        (msg as { model?: string }).model = targetModel.modelId;
      }
    }

    // Post-pass: ensure every toolResult has a matching toolCall in a
    // preceding assistant message.  Orphaned tool_results can appear when
    // a policy-based require_approval wrapper returned early before the
    // onToolCall callback was wired up.
    const knownToolCallIds = new Set<string>();
    for (const msg of messages) {
      if (msg.role === 'assistant') {
        for (const b of msg.content) {
          if (b.type === 'toolCall') knownToolCallIds.add((b as { id: string }).id);
        }
      }
    }
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i]!;
      if (msg.role !== 'toolResult') continue;
      const tr = msg as import('@mariozechner/pi-ai').ToolResultMessage;
      if (knownToolCallIds.has(tr.toolCallId)) continue;
      // Find or create a preceding assistant message to attach the synthetic toolCall.
      let target: import('@mariozechner/pi-ai').AssistantMessage | undefined;
      for (let j = i - 1; j >= 0; j--) {
        if (messages[j]!.role === 'assistant') {
          target = messages[j] as import('@mariozechner/pi-ai').AssistantMessage;
          break;
        }
      }
      const syntheticToolCall: import('@mariozechner/pi-ai').ToolCall = {
        type: 'toolCall',
        id: tr.toolCallId,
        name: tr.toolName,
        arguments: {},
      };
      if (target) {
        target.content.push(syntheticToolCall);
        if (target.stopReason !== 'toolUse') target.stopReason = 'toolUse';
      } else {
        const syntheticAssistant: import('@mariozechner/pi-ai').AssistantMessage = {
          role: 'assistant',
          content: [syntheticToolCall],
          api: 'anthropic-messages',
          provider: 'anthropic',
          model: 'unknown',
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: 'toolUse',
          timestamp: tr.timestamp,
        };
        messages.splice(i, 0, syntheticAssistant);
        i++;
      }
      knownToolCallIds.add(tr.toolCallId);
    }

    this.logRuntime(
      `[${sessionId}] resumed with ${messages.length} messages from DB`
      + (compactionSummary ? ' (with compaction summary)' : ''),
    );

    return messages;
  }

  private async transformContext(
    sessionId: string,
    messages: AgentMessage[],
    _signal?: AbortSignal,
  ): Promise<AgentMessage[]> {
    const config = await this.options.security.readConfig();
    const sessionWorking =
      (await this.store.messages.getSessionWorkingMemory(this.scope, sessionId)) ?? '';

    const contextBlocks: AgentMessage[] = [];

    // When a resumed session has at most 1 message in the current agent
    // instance, restore the full message history from DB so compaction
    // and LLM conversion work identically to a live session.
    const session = this.sessions.get(sessionId);
    let restoredMessages: AgentMessage[] = [];
    if (session?.resumed && messages.length <= 1) {
      const resolved = resolveModel(config);
      restoredMessages = await this.buildResumptionMessages(sessionId, {
        provider: config.model.provider,
        api: resolved.api,
        modelId: resolved.id,
      });
      session.resumed = false;
    }

    if (sessionWorking.trim()) {
      contextBlocks.push({
        role: 'user',
        content: [
          {
            type: 'text',
            text: `Session-local working memory (read-only context):\n\n${sessionWorking}`,
          },
        ],
        timestamp: Date.now(),
      });
    }

    // Prepend restored history from DB so it's treated identically to
    // messages that accumulated in memory during a live session.
    const allMessages = restoredMessages.length > 0
      ? [...restoredMessages, ...messages]
      : messages;

    // Truncate oversized tool results before compaction so that a single
    // huge tool response cannot blow past the entire context window.
    const model = resolveModel(config);
    const truncatedMessages = truncateToolResults(allMessages, model.contextWindow);

    // Only offer LLM compaction when we have a dedicated API key.
    // When streamFn is provided (tests, proxied setups), the shared stream
    // should not be consumed by an internal compaction turn.
    const canRunLlmCompaction =
      !this.options.streamFn && Boolean(this.resolveApiKey(config.model.provider));

    const finalMessages = await compactContextIfNeeded(sessionId, config, contextBlocks, truncatedMessages, {
      store: this.store,
      scope: this.scope,
      options: {
        contextCompactionMaxTokens: this.options.contextCompactionMaxTokens,
        contextCompactionRecentMessageCount: this.options.contextCompactionRecentMessageCount,
        contextCompactionSummaryMaxChars: this.options.contextCompactionSummaryMaxChars,
      },
      createCompactionAgent: canRunLlmCompaction
        ? (sid) => this.createCompactionAgent(sid, config)
        : undefined,
      logRuntime: (msg) => this.logRuntime(msg),
    });

    if (AgentRunner.DEBUG) {
      const budget = getContextCompactionMaxTokens(config, {
        contextCompactionMaxTokens: this.options.contextCompactionMaxTokens,
      });
      const totalTokens = estimateAgentMessagesTokens(finalMessages);
      const contextTokens = estimateAgentMessagesTokens(contextBlocks);
      const messageTokens = estimateAgentMessagesTokens(messages);
      const pct = ((totalTokens / model.contextWindow) * 100).toFixed(1);

      const roleCounts = finalMessages.reduce<Record<string, number>>((acc, m) => {
        acc[m.role] = (acc[m.role] ?? 0) + 1;
        return acc;
      }, {});

      this.logDebug(
        `[${sessionId}] model: ${config.model.provider}/${config.model.model} | `
        + `context: ${totalTokens.toLocaleString()}/${model.contextWindow.toLocaleString()} tokens (${pct}%) | `
        + `budget: ${budget.toLocaleString()} | ctx blocks: ${contextTokens.toLocaleString()} | msgs: ${messageTokens.toLocaleString()} | `
        + `final: ${finalMessages.length} (${Object.entries(roleCounts).map(([r, c]) => `${r}:${c}`).join(' ')})`,
      );
    }

    return finalMessages;
  }

  private async createCompactionAgent(sessionId: string, config: AgentConfig): Promise<Agent> {
    const langfuseTurnContext: LangfuseTurnContext | undefined = this.options.langfuse
      ? {
          currentTrace: this.options.langfuse.trace({
            name: 'openhermit.compaction',
            sessionId,
          }),
        }
      : undefined;

    return this.createConfiguredAgent({
      config,
      agentSessionId: `${sessionId}:compaction`,
      contextSessionId: sessionId,
      extraSystemPrompt: [
        'Internal compaction turn:',
        '- This is an internal runtime turn, not a user-facing reply.',
        '- Summarize the compacted conversation below into a coherent narrative.',
        '- Capture: key topics discussed, decisions made, important file paths or data, outstanding tasks or questions.',
        '- Be concise but preserve important context that will help the agent continue the conversation.',
        '- Return JSON only with key "compactionSummary".',
        '- Do not call tools.',
        '- Do not wrap the JSON in markdown fences.',
      ].join('\n'),
      tools: [],
      ...(langfuseTurnContext ? { langfuseTurnContext } : {}),
    });
  }

  private resolveWebProvider(config: AgentConfig): WebProvider | undefined {
    const providerName = config.web?.provider ?? 'defuddle';

    if (providerName === 'defuddle') {
      return createWebProvider('defuddle');
    }

    const apiKey = this.resolveApiKey(providerName);
    if (!apiKey) {
      this.logRuntime(`web provider "${providerName}" skipped: no API key found`);
      return undefined;
    }

    return createWebProvider(providerName, apiKey);
  }

  private resolveApiKey(provider: string): string | undefined {
    const candidates = createProviderSecretCandidates(provider);

    for (const candidate of candidates) {
      try {
        return this.options.security.resolveSecrets([candidate])[candidate];
      } catch {
        const envValue = process.env[candidate];

        if (envValue) {
          return envValue;
        }
      }
    }

    return undefined;
  }

  private ensureProviderApiKey(provider: string): void {
    const apiKey = this.resolveApiKey(provider);

    if (apiKey) {
      return;
    }

    throw new ValidationError(
      formatMissingApiKeyMessage(
        provider,
        `agent ${this.scope.agentId} secrets`,
      ),
    );
  }

  private handleAgentEvent(session: RunnerSession, event: AgentEvent): void {
    switch (event.type) {
      case 'agent_start': {
        const ts = new Date().toISOString();
        void this.queueSideEffect(session, async () => {
          await this.store.messages.appendLogEntry(this.scope,session.spec.sessionId, {
            ts,
            role: 'system',
            type: 'agent_start',
          });
        });
        break;
      }

      case 'message_update': {
        if (event.assistantMessageEvent.type === 'thinking_delta') {
          void this.events.publish({
            type: 'thinking_delta',
            sessionId: session.spec.sessionId,
            text: event.assistantMessageEvent.delta,
          });
        }

        if (event.assistantMessageEvent.type === 'thinking_end') {
          void this.events.publish({
            type: 'thinking_final',
            sessionId: session.spec.sessionId,
            text: event.assistantMessageEvent.content,
          });
        }

        if (event.assistantMessageEvent.type === 'text_delta') {
          void this.events.publish({
            type: 'text_delta',
            sessionId: session.spec.sessionId,
            text: event.assistantMessageEvent.delta,
          });
        }

        if (event.assistantMessageEvent.type === 'error') {
          void this.events.publish({
            type: 'error',
            sessionId: session.spec.sessionId,
            message: event.assistantMessageEvent.error.errorMessage ?? 'Model stream failed.',
          });
        }
        break;
      }

      case 'message_end': {
        if (!isAssistantMessage(event.message)) {
          break;
        }

        const assistantText = extractAssistantText(event.message);
        const thinkingText = extractThinkingText(event.message);
        const thinkingSignature = extractThinkingSignature(event.message);
        const assistantMessage = event.message;

        // Handle error responses from the model provider.
        if (assistantMessage.stopReason === 'error') {
          const errorMsg = assistantMessage.errorMessage ?? 'Model returned an error.';
          const ts = new Date().toISOString();
          session.updatedAt = ts;
          void this.persistSessionIndex(session);

          agentErrorsTotal.inc({ agent_id: this.scope.agentId, source: 'model' });

          this.logRuntime(`model error in ${session.spec.sessionId}: ${errorMsg}`);

          void this.events.publish({
            type: 'error',
            sessionId: session.spec.sessionId,
            message: errorMsg,
          });

          void this.queueSideEffect(session, async () => {
            await this.store.messages.appendLogEntry(this.scope, session.spec.sessionId, {
              ts,
              role: 'assistant',
              content: assistantText ?? '',
              ...(thinkingText ? { thinking: thinkingText } : {}),
              ...(thinkingSignature ? { thinkingSignature } : {}),
              provider: assistantMessage.provider,
              model: assistantMessage.model,
              usage: assistantMessage.usage,
              stopReason: 'error',
              errorMessage: errorMsg,
            });
          });
          break;
        }

        const hasText = assistantText && hasMeaningfulAssistantText(assistantText);
        const hasThinking = thinkingText && thinkingText.length > 0;

        // When model outputs only thinking with no text (e.g. DeepSeek R1 final answer),
        // promote thinking to assistant text if this is the final message (not a tool call).
        const isFinalThinkingOnly = !hasText && hasThinking && assistantMessage.stopReason !== 'toolUse';
        const effectiveText = isFinalThinkingOnly ? thinkingText : (assistantText || '');
        const effectiveThinking = isFinalThinkingOnly ? undefined : (hasThinking ? thinkingText : undefined);

        if (!hasText && !hasThinking) {
          break;
        }

        if (isFinalThinkingOnly) {
          void this.events.publish({
            type: 'text_final',
            sessionId: session.spec.sessionId,
            text: thinkingText,
          });
        }

        session.latestAssistantText = effectiveText;
        session.messageCount += 1;
        session.lastMessagePreview = effectiveText;
        const ts = new Date().toISOString();
        session.updatedAt = ts;
        void this.persistSessionIndex(session);

        if (assistantMessage.usage) {
          const u = assistantMessage.usage;
          if (u.input) agentTokensTotal.inc({ agent_id: this.scope.agentId, direction: 'in' }, u.input);
          if (u.output) agentTokensTotal.inc({ agent_id: this.scope.agentId, direction: 'out' }, u.output);
          if (u.cacheRead) agentTokensTotal.inc({ agent_id: this.scope.agentId, direction: 'cache_read' }, u.cacheRead);
          if (u.cacheWrite) agentTokensTotal.inc({ agent_id: this.scope.agentId, direction: 'cache_write' }, u.cacheWrite);
        }

        void this.queueSideEffect(session, async () => {
          await this.store.messages.appendLogEntry(this.scope, session.spec.sessionId, {
            ts,
            role: 'assistant',
            content: effectiveText,
            ...(effectiveThinking ? { thinking: effectiveThinking } : {}),
            ...(effectiveThinking && thinkingSignature ? { thinkingSignature } : {}),
            provider: assistantMessage.provider,
            model: assistantMessage.model,
            usage: assistantMessage.usage,
            stopReason: assistantMessage.stopReason,
          });
        });
        break;
      }

      case 'tool_execution_start': {
        break;
      }

      case 'tool_execution_end': {
        const ts = new Date().toISOString();
        const resultText = extractToolResultText(event.result);
        const resultDetails = extractToolResultDetails(event.result);

        // For large tool results, build an inline head+tail preview so we
        // don't bloat events or context.  The full output is persisted to
        // workspace/.openhermit/tool_results/<id>.json in the side-effect.
        const truncation = resultText
          ? buildToolResultPreview(event.toolCallId, resultText)
          : null;
        const publishText = truncation ? truncation.preview : resultText;

        void this.events.publish({
          type: 'tool_result',
          sessionId: session.spec.sessionId,
          tool: event.toolName,
          toolCallId: event.toolCallId,
          isError: event.isError,
          ...(publishText ? { text: publishText } : {}),
          ...(resultDetails !== undefined ? { details: resultDetails } : {}),
        });

        void this.queueSideEffect(session, async () => {
          if (truncation && resultText) {
            await persistToolResult(this.options.workspace, event.toolCallId, resultText);
          }
          await this.store.messages.appendLogEntry(this.scope, session.spec.sessionId, {
            ts,
            role: 'tool_result',
            name: event.toolName,
            toolCallId: event.toolCallId,
            isError: event.isError,
            content: truncation ? truncation.preview : serializeDetails(event.result),
          });
        });
        break;
      }

      case 'agent_end': {
        const ts = new Date().toISOString();
        let finalText = session.latestAssistantText;
        const lastUserMessageText = session.lastUserMessageText;
        session.completedTurnCount += 1;
        session.updatedAt = ts;
        session.status = 'idle';
        agentTurnsTotal.inc({ agent_id: this.scope.agentId });
        if (session.turnStartMs) {
          agentTurnDuration.observe(
            { agent_id: this.scope.agentId },
            (Date.now() - session.turnStartMs) / 1000,
          );
          delete session.turnStartMs;
        }
        void this.persistSessionIndex(session);
        this.scheduleIdleSummary(session);
        void this.queueBackgroundTask(session, async () => {
          const config = await this.options.security.readConfig();

          const turnsSinceLast = await this.store.messages.getTurnsSinceLastIntrospection(
            this.scope,
            session.spec.sessionId,
          );
          if (turnsSinceLast >= this.getCheckpointTurnInterval(config)) {
            await this.runSessionCheckpoint(session, 'turn_limit');
          }

        });

        void (async () => {
          // For channel-bound sessions, run the channel.message.out@v1
          // transform so plugins can scrub/rewrite outbound text (e.g.
          // PII unmasking, brand-voice enforcement) before adapters
          // receive it.
          if (
            finalText
            && session.spec.source.kind === 'channel'
            && session.spec.source.platform
          ) {
            const out = await this.bus.transform('channel.message.out@v1', {
              agentId: this.scope.agentId,
              sessionId: session.spec.sessionId,
              channel: session.spec.source.platform,
              direction: 'out',
              text: finalText,
            });
            finalText = out.text;
          }

          if (finalText) {
            await this.events.publish({
              type: 'text_final',
              sessionId: session.spec.sessionId,
              text: finalText,
            });
          }

          await this.events.publish({
            type: 'agent_end',
            sessionId: session.spec.sessionId,
          });
        })();

        if (this.options.langfuse && session.langfuseTurnContext) {
          void endTurnTrace(this.options.langfuse, session.langfuseTurnContext, {
            ...(finalText ? { text: finalText } : {}),
          });
        }

        session.latestAssistantText = undefined;
        void this.queueSideEffect(session, async () => {
          await this.store.messages.appendLogEntry(this.scope,session.spec.sessionId, {
            ts,
            role: 'system',
            type: 'agent_end',
          });
        });
        break;
      }

      default:
        break;
    }
  }

  private async handleRunError(
    session: RunnerSession,
    error: unknown,
  ): Promise<void> {
    const message = getErrorMessage(error);
    const ts = new Date().toISOString();
    this.clearIdleSummaryTimer(session);
    session.updatedAt = ts;
    session.status = 'idle';
    agentErrorsTotal.inc({ agent_id: this.scope.agentId, source: 'runtime' });
    if (session.turnStartMs) {
      agentTurnDuration.observe(
        { agent_id: this.scope.agentId },
        (Date.now() - session.turnStartMs) / 1000,
      );
      delete session.turnStartMs;
    }
    await this.persistSessionIndex(session);

    if (this.options.langfuse && session.langfuseTurnContext) {
      void endTurnTrace(this.options.langfuse, session.langfuseTurnContext, {
        error: message,
      });
    }

    try {
      await this.events.publish({
        type: 'error',
        sessionId: session.spec.sessionId,
        message,
      });
      await this.events.publish({
        type: 'agent_end',
        sessionId: session.spec.sessionId,
      });
      this.scheduleIdleSummary(session);
      await this.queueSideEffect(session, async () => {
        await this.store.messages.appendLogEntry(this.scope,session.spec.sessionId, {
          ts,
          role: 'error',
          message,
        });
      });
    } catch (persistenceError) {
      console.error(
        `[openhermit-agent] failed to surface run error for ${session.spec.sessionId}`,
        persistenceError,
      );
    }
  }

  private async queueSideEffect(
    session: RunnerSession,
    work: () => Promise<void>,
  ): Promise<void> {
    const queued = session.sideEffects.then(work, work);
    session.sideEffects = queued.catch((error) => {
      console.error(
        `[openhermit-agent] failed to persist session side effect for ${session.spec.sessionId}`,
        error,
      );
    });
    return queued;
  }

  private async queueBackgroundTask(
    session: RunnerSession,
    work: () => Promise<void>,
  ): Promise<void> {
    const queued = session.backgroundTasks.then(work, work);
    session.backgroundTasks = queued.catch((error) => {
      console.error(
        `[openhermit-agent] failed to run background task for ${session.spec.sessionId}`,
        error,
      );
    });
    return queued;
  }

  private getRequiredSession(sessionId: string): RunnerSession {
    const session = this.sessions.get(sessionId);

    if (!session) {
      throw new NotFoundError(`Session not found: ${sessionId}`);
    }

    return session;
  }

  private async persistSessionIndex(session: RunnerSession): Promise<void> {
    await this.store.sessions.upsert(this.scope,createPersistedSessionIndexEntry(session));
  }

  async listSessionLogEntries(sessionId: string) {
    const activeSession = this.sessions.get(sessionId);
    if (activeSession) {
      await activeSession.sideEffects.catch(() => undefined);
    }
    return this.store.messages.listSessionEntries(this.scope,sessionId);
  }


}
