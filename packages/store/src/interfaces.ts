import type { SessionHistoryMessage, SessionSpec } from '@openhermit/protocol';

import type {
  AgentMcpServerRecord,
  AgentRecord,
  AgentStatus,
  AgentSkillRecord,
  ApprovalRequestCreateInput,
  ApprovalRequestRecord,
  ApprovalResolution,
  ApprovalStatus,
  McpServerRecord,
  MessageRow,
  InstructionEntry,
  MemoryAddInput,
  MemoryEntry,
  MemorySearchOptions,
  MemoryUpdateInput,
  PersistedSessionIndexEntry,
  PolicyRecord,
  SandboxCreateInput,
  SandboxRecord,
  SandboxStatus,
  ScheduleCreateInput,
  ScheduleRecord,
  ScheduleRunRecord,
  ScheduleUpdateInput,
  SessionLogEntry,
  SkillRecord,
  StoreScope,
  UserAgentRecord,
  UserIdentity,
  UserRecord,
  UserRole,
} from './types.js';

export interface SessionStore {
  upsert(scope: StoreScope, entry: PersistedSessionIndexEntry): Promise<void>;
  get(scope: StoreScope, sessionId: string): Promise<PersistedSessionIndexEntry | undefined>;
  list(scope: StoreScope, options?: { userId?: string; includeInactive?: boolean }): Promise<PersistedSessionIndexEntry[]>;
  updateDescription(scope: StoreScope, sessionId: string, description: string, source: 'fallback' | 'ai'): Promise<void>;
  updateStatus(scope: StoreScope, sessionId: string, status: string): Promise<void>;
  delete(scope: StoreScope, sessionId: string): Promise<void>;
  markStaleInactive(scope: StoreScope, olderThanIso: string): Promise<number>;
  waitForIdle(): Promise<void>;
}

export interface MessageStore {
  appendLogEntry(scope: StoreScope, sessionId: string, entry: SessionLogEntry): Promise<number>;
  /** Lookup an existing entry's id by the messageId stamped in its payload.
   *  Used to make idempotent appends a no-op on retry. Returns null if no
   *  entry with that messageId exists in this session. */
  findEntryIdByMessageId(scope: StoreScope, sessionId: string, messageId: string): Promise<number | null>;
  writeSessionStarted(scope: StoreScope, spec: SessionSpec, model: { provider: string; model: string }): Promise<void>;
  listHistoryMessages(scope: StoreScope, sessionId: string): Promise<SessionHistoryMessage[]>;
  listMessagesSinceEvent(scope: StoreScope, sessionId: string, afterEventId: number): Promise<MessageRow[]>;
  getLatestEventId(scope: StoreScope, sessionId: string): Promise<number>;
  getLastIntrospectionEventId(scope: StoreScope, sessionId: string): Promise<number>;
  getTurnsSinceLastIntrospection(scope: StoreScope, sessionId: string): Promise<number>;
  getUserMessagesSinceLastIntrospection(scope: StoreScope, sessionId: string): Promise<number>;
  listSessionEntries(scope: StoreScope, sessionId: string): Promise<SessionLogEntry[]>;
  getSessionWorkingMemory(scope: StoreScope, sessionId: string): Promise<string | undefined>;
  setSessionWorkingMemory(scope: StoreScope, sessionId: string, content: string, updatedAt: string): Promise<void>;
  listRecentMessages(scope: StoreScope, sessionId: string, limit: number, offset?: number): Promise<MessageRow[]>;
  listSessionEntriesSinceLastCompaction(scope: StoreScope, sessionId: string): Promise<{ compactionSummary: string | undefined; entries: SessionLogEntry[] }>;
  getCompactionSummary(scope: StoreScope, sessionId: string): Promise<string | undefined>;
  setCompactionSummary(scope: StoreScope, sessionId: string, content: string, updatedAt: string): Promise<void>;
}

export interface MemoryProvider {
  readonly name: string;
  initialize(scope: StoreScope): Promise<void>;
  shutdown(): Promise<void>;
  add(scope: StoreScope, input: MemoryAddInput): Promise<MemoryEntry>;
  search(scope: StoreScope, query: string, options?: MemorySearchOptions): Promise<MemoryEntry[]>;
  list(scope: StoreScope, prefix: string, options?: { limit?: number }): Promise<MemoryEntry[]>;
  get(scope: StoreScope, id: string): Promise<MemoryEntry | undefined>;
  update(scope: StoreScope, id: string, input: MemoryUpdateInput): Promise<MemoryEntry>;
  delete(scope: StoreScope, id: string): Promise<void>;
  getContextBlock(scope: StoreScope, options?: { limit?: number | undefined }): Promise<string | undefined>;
}

export interface InstructionStore {
  get(scope: StoreScope, key: string): Promise<InstructionEntry | undefined>;
  getAll(scope: StoreScope): Promise<InstructionEntry[]>;
  set(scope: StoreScope, key: string, content: string, updatedAt: string): Promise<void>;
  delete(scope: StoreScope, key: string): Promise<void>;
}

export interface UserStore {
  /** Create or update a global user record. */
  upsert(user: UserRecord): Promise<void>;

  /** Get a user by ID. Returns undefined if not found or if merged. */
  get(userId: string): Promise<UserRecord | undefined>;

  /** List all active users (excludes merged records). */
  list(): Promise<UserRecord[]>;

  /** Link a channel identity to a user (global, not per-agent). */
  linkIdentity(identity: UserIdentity): Promise<void>;

  /** Resolve a channel identity to a user ID. Follows merged_into if needed. */
  resolve(channel: string, channelUserId: string): Promise<string | undefined>;

  /** Remove a channel identity link. */
  unlinkIdentity(channel: string, channelUserId: string): Promise<void>;

  /** List identities for a given user. */
  listIdentities(userId: string): Promise<UserIdentity[]>;

  /** Batch: list identities for many users in a single query. */
  listIdentitiesByUserIds(userIds: string[]): Promise<Map<string, UserIdentity[]>>;

  /** Mark a user as merged into another. Re-links all identities to the target. */
  merge(fromUserId: string, intoUserId: string): Promise<void>;

  /** Delete a user and all their identities. */
  delete(userId: string): Promise<void>;

  /** Assign a role to a user for an agent. */
  assignAgent(scope: StoreScope, userId: string, role: UserRole, createdAt: string): Promise<void>;

  /** Remove a user's membership on a specific agent. */
  removeAgent(scope: StoreScope, userId: string): Promise<void>;

  /** Get a user's role for a specific agent. */
  getAgentRole(scope: StoreScope, userId: string): Promise<UserRole | undefined>;

  /** List users for an agent (with roles). */
  listByAgent(scope: StoreScope): Promise<UserAgentRecord[]>;

  /** Batch: list (agentId, role) bindings for many users in a single query. */
  listAgentRolesByUserIds(userIds: string[]): Promise<Map<string, UserAgentRecord[]>>;
}

export interface SkillStore {
  /** Create or update a skill in the library. */
  upsert(skill: SkillRecord): Promise<void>;
  /** Get a skill by ID. */
  get(id: string): Promise<SkillRecord | undefined>;
  /** List all skills in the library. */
  list(): Promise<SkillRecord[]>;
  /** Delete a skill and all its agent assignments. */
  delete(id: string): Promise<void>;
  /** Enable a skill for an agent (use agentId='*' for all agents). */
  enable(agentId: string, skillId: string): Promise<void>;
  /** Disable a skill for an agent. */
  disable(agentId: string, skillId: string): Promise<void>;
  /** List enabled skills for an agent (includes global '*' assignments). */
  listEnabled(agentId: string): Promise<SkillRecord[]>;
  /** List all agent-skill assignments. */
  listAssignments(skillId?: string): Promise<AgentSkillRecord[]>;
}

export interface McpServerStore {
  upsert(server: McpServerRecord): Promise<void>;
  get(id: string): Promise<McpServerRecord | undefined>;
  list(): Promise<McpServerRecord[]>;
  delete(id: string): Promise<void>;
  enable(agentId: string, mcpServerId: string): Promise<void>;
  disable(agentId: string, mcpServerId: string): Promise<void>;
  listEnabled(agentId: string): Promise<McpServerRecord[]>;
  listAssignments(mcpServerId?: string): Promise<AgentMcpServerRecord[]>;
}

export interface AgentStore {
  create(agent: AgentRecord): Promise<AgentRecord>;
  get(agentId: string): Promise<AgentRecord | undefined>;
  list(): Promise<AgentRecord[]>;
  update(agentId: string, patch: Partial<Pick<AgentRecord, 'name' | 'workspaceDir'>>): Promise<AgentRecord | undefined>;
  /**
   * Update the agent's status to 'active' or 'disabled'. Returns the
   * updated record, or undefined if the agent doesn't exist. The gateway
   * uses this to disable an agent without deleting it.
   */
  setStatus(agentId: string, status: AgentStatus): Promise<AgentRecord | undefined>;
  delete(agentId: string): Promise<void>;
  getBackendState(agentId: string): Promise<Record<string, unknown> | null>;
  setBackendState(agentId: string, state: Record<string, unknown>): Promise<void>;
}

/**
 * Canonical store for an agent's runtime config (config.json) and
 * security policy (security.json). Implemented over the agents table.
 *
 * `path` is dot-notation against the parsed JSON document, e.g.
 * `model.provider`. When omitted, the whole document is read or
 * replaced.
 */
export interface AgentConfigStore {
  getConfig(agentId: string): Promise<Record<string, unknown> | null>;
  setConfig(agentId: string, config: Record<string, unknown>): Promise<void>;
  getSecurity(agentId: string): Promise<Record<string, unknown> | null>;
  setSecurity(agentId: string, policy: Record<string, unknown>): Promise<void>;
  /** Read a single nested value from the config document. */
  getConfigPath(agentId: string, path: string): Promise<unknown>;
  /** Write a single nested value into the config document, preserving the rest. */
  setConfigPath(agentId: string, path: string, value: unknown): Promise<void>;
  /** Read a single nested value from the security document. */
  getSecurityPath(agentId: string, path: string): Promise<unknown>;
  /** Write a single nested value into the security document, preserving the rest. */
  setSecurityPath(agentId: string, path: string, value: unknown): Promise<void>;
}

/**
 * Per-agent secret storage. Today implemented as a file (secrets.json),
 * tomorrow may be DB-backed; either way callers go through this
 * interface and never read the file directly.
 */
/** Secret entry with metadata. */
export interface SecretEntry {
  value: string;
  /**
   * When true, the secret is injected as an environment variable into the
   * agent's sandboxes at startup so tools running inside can read it via
   * process.env. Default false.
   */
  passThrough: boolean;
}

export interface SecretStore {
  /** Returns name → plaintext value (passThrough flag dropped). */
  list(agentId: string): Promise<Record<string, string>>;
  /** Returns name → { value, passThrough } records. */
  listEntries(agentId: string): Promise<Record<string, SecretEntry>>;
  get(agentId: string, name: string): Promise<string | undefined>;
  set(agentId: string, name: string, value: string, options?: { passThrough?: boolean }): Promise<void>;
  delete(agentId: string, name: string): Promise<void>;
  /** Bulk replacement — used by PUT /api/agents/:id/secrets. */
  setAll(agentId: string, secrets: Record<string, string>): Promise<void>;
}

export interface ScheduleStore {
  create(scope: StoreScope, input: ScheduleCreateInput): Promise<ScheduleRecord>;
  get(scope: StoreScope, scheduleId: string): Promise<ScheduleRecord | undefined>;
  list(scope: StoreScope, options?: { status?: string }): Promise<ScheduleRecord[]>;
  listDue(scope: StoreScope, now: string): Promise<ScheduleRecord[]>;
  /**
   * Cross-agent scan for active schedules whose `next_run_at` is set and
   * has elapsed. Used by the gateway's central scheduler.
   */
  listAllDue(now: string): Promise<ScheduleRecord[]>;
  /**
   * Cross-agent scan for active cron schedules that have not yet been
   * scheduled (`next_run_at IS NULL`). The central scheduler computes
   * their next run on first sight and persists it via `markRun`.
   */
  listAllOrphanedCron(): Promise<ScheduleRecord[]>;
  update(scope: StoreScope, scheduleId: string, input: ScheduleUpdateInput): Promise<ScheduleRecord>;
  delete(scope: StoreScope, scheduleId: string): Promise<void>;
  markRun(scope: StoreScope, scheduleId: string, nextRunAt: string | null, error?: string): Promise<void>;
  /**
   * Update only `next_run_at` (and `updated_at`). Used by the central
   * scheduler to bootstrap newly created cron rows without bumping
   * `run_count` or touching `last_run_at`.
   */
  setNextRun(scope: StoreScope, scheduleId: string, nextRunAt: string | null): Promise<void>;
  startRun(scope: StoreScope, scheduleId: string, sessionId: string, prompt: string): Promise<ScheduleRunRecord>;
  finishRun(scope: StoreScope, runId: number, status: 'completed' | 'failed', error?: string): Promise<ScheduleRunRecord>;
  listRuns(scope: StoreScope, scheduleId: string, limit?: number): Promise<ScheduleRunRecord[]>;
}

export interface SandboxStore {
  create(input: SandboxCreateInput): Promise<SandboxRecord>;
  get(id: string): Promise<SandboxRecord | undefined>;
  getByAlias(agentId: string, alias: string): Promise<SandboxRecord | undefined>;
  listByAgent(agentId: string): Promise<SandboxRecord[]>;
  /** List every non-deleted sandbox across all agents. Admin-only. */
  listAll(): Promise<SandboxRecord[]>;
  /** Update mutable fields. Bumps updatedAt automatically. */
  update(
    id: string,
    patch: Partial<{
      status: SandboxStatus;
      externalId: string | null;
      config: Record<string, unknown>;
      runtimeState: Record<string, unknown>;
      lastSeenAt: string | null;
    }>,
  ): Promise<SandboxRecord | undefined>;
  delete(id: string): Promise<void>;
  /** Find the agent (if any) that already has a sandbox of the given type. */
  findAgentByType(type: string, excludeAgentId?: string): Promise<string | null>;
}

export interface PolicyStore {
  list(agentId: string, resourceType?: string): Promise<PolicyRecord[]>;
  get(
    agentId: string,
    resourceType: string,
    resourceKey: string,
    effect?: string,
  ): Promise<PolicyRecord | undefined>;
  upsert(record: Omit<PolicyRecord, 'id' | 'createdAt' | 'updatedAt'>): Promise<PolicyRecord>;
  delete(
    agentId: string,
    resourceType: string,
    resourceKey: string,
    effect?: string,
  ): Promise<void>;
}

export interface ApprovalRequestStore {
  create(input: ApprovalRequestCreateInput): Promise<ApprovalRequestRecord>;
  get(id: string): Promise<ApprovalRequestRecord | undefined>;
  getByShortId(shortId: number): Promise<ApprovalRequestRecord | undefined>;
  list(agentId: string, status?: ApprovalStatus): Promise<ApprovalRequestRecord[]>;
  /** Find an approved request matching the given criteria (for retry flow). */
  findApproved(
    agentId: string,
    requesterId: string,
    resourceType: string,
    resourceKey: string,
  ): Promise<ApprovalRequestRecord | undefined>;
  resolve(
    id: string,
    decision: 'approved' | 'rejected',
    resolvedBy: string,
    resolution?: ApprovalResolution,
    reason?: string,
  ): Promise<ApprovalRequestRecord>;
  expireOld(): Promise<number>;
}

export interface InternalStateStore {
  sessions: SessionStore;
  messages: MessageStore;
  memories: MemoryProvider;
  instructions: InstructionStore;
  users: UserStore;
  schedules: ScheduleStore;
  close(): Promise<void>;
}
