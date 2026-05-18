import type {
  MetadataValue,
  SessionHistoryMessage,
  SessionSource,
  SessionSpec,
  SessionStatus,
  SessionType,
} from '@openhermit/protocol';

export interface StoreScope {
  agentId: string;
}

export type AgentStatus = 'active' | 'disabled';

export interface AgentRecord {
  agentId: string;
  name?: string;
  workspaceDir: string;
  /** Source of truth for whether the gateway accepts requests for this agent. */
  status: AgentStatus;
  createdAt: string;
  updatedAt: string;
}

export type SandboxType = 'host' | 'docker' | 'e2b' | 'daytona';

/**
 * Lifecycle state of a sandbox row — intent, not live runtime status.
 *
 * - `pending`: row exists, backend resource has never been provisioned.
 *   Provisioning is lazy; first `ensure()` flips this to `provisioned`.
 * - `provisioned`: backend resource has been provisioned at least once.
 *   Stays `provisioned` even if the upstream sandbox is paused / reaped —
 *   `ensure()` re-provisions transparently and refreshes `external_id`.
 * - `deleted`: soft-deleted; row kept for audit, never selected for use.
 */
export type SandboxStatus = 'pending' | 'provisioned' | 'deleted';

export interface SandboxRecord {
  id: string;
  agentId: string;
  alias: string;
  type: SandboxType;
  externalId: string | null;
  status: SandboxStatus;
  /** Backend creation params: image/template, agent_home, username, lifecycle/timeouts. */
  config: Record<string, unknown>;
  /** Mutable per-backend state (e.g. e2b pendingSkillManifest). */
  runtimeState: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string | null;
}

export type PolicyEffect = 'allow' | 'deny' | 'require_approval';

export interface PolicyRecord {
  id: string;
  agentId: string;
  resourceType: string;
  resourceKey: string;
  effect: PolicyEffect;
  grants: unknown[];
  scope: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired';
export type ApprovalResolution = 'once' | 'persistent';

export interface ApprovalRequestRecord {
  id: string;
  shortId: number;
  agentId: string;
  sessionId: string;
  requesterId: string;
  resourceType: string;
  resourceKey: string;
  scope: Record<string, unknown>;
  status: ApprovalStatus;
  resolution: ApprovalResolution | null;
  resolvedBy: string | null;
  reason: string | null;
  createdAt: string;
  resolvedAt: string | null;
  ttlMinutes: number;
}

export interface ApprovalRequestCreateInput {
  agentId: string;
  sessionId: string;
  requesterId: string;
  resourceType: string;
  resourceKey: string;
  scope?: Record<string, unknown>;
  ttlMinutes?: number;
}

export type AttachmentMaterializationState =
  | 'pending'
  | 'copied'
  | 'skipped'
  | 'failed';

/** 'local' | 's3' | 'supabase' — open string so providers can be added without a schema bump. */
export type AttachmentStorageProvider = string;

export interface AttachmentRecord {
  id: string;
  agentId: string;
  sessionId: string;
  uploaderUserId: string | null;
  originalName: string;
  safeName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  storageProvider: AttachmentStorageProvider;
  storageKey: string;
  sandboxId: string | null;
  sandboxPath: string | null;
  materializationState: AttachmentMaterializationState;
  materializationError: string | null;
  createdAt: string;
}

export interface AttachmentCreateInput {
  id?: string;
  agentId: string;
  sessionId: string;
  uploaderUserId?: string | null;
  originalName: string;
  safeName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  storageProvider: AttachmentStorageProvider;
  storageKey: string;
}

export interface AttachmentListOptions {
  /** Defaults to 'session'. */
  scope?: 'session' | 'user';
  /** Required when `scope` is 'user' — never permit cross-user listing. */
  userId?: string;
  limit?: number;
}

export interface AttachmentMaterializationPatch {
  sandboxId?: string | null;
  sandboxPath?: string | null;
  state: AttachmentMaterializationState;
  error?: string | null;
}

export interface SandboxCreateInput {
  id?: string;
  agentId: string;
  alias: string;
  type: SandboxType;
  externalId?: string | null;
  status?: SandboxStatus;
  config?: Record<string, unknown>;
  runtimeState?: Record<string, unknown>;
}

export const STANDALONE_AGENT_ID = '__standalone__';

export const standaloneScope: StoreScope = { agentId: STANDALONE_AGENT_ID };

export interface PersistedSessionIndexEntry {
  sessionId: string;
  source: SessionSource;
  status?: SessionStatus;
  createdAt: string;
  lastActivityAt: string;
  messageCount: number;
  completedTurnCount?: number;
  description?: string;
  descriptionSource?: 'fallback' | 'ai';
  lastMessagePreview?: string;
  metadata?: Record<string, MetadataValue>;
  type?: SessionType;
  userIds?: string[];
  /** Per-session prompt addendum, set once at create. */
  customInstruction?: string;
}

export interface SessionLogEntry {
  ts: string;
  role: 'system' | 'user' | 'assistant' | 'tool_call' | 'tool_result' | 'error';
  type?: string;
  /**
   * Inline interactive affordances (e.g. approval Approve/Reject buttons)
   * surfaced on this message. Promoted from metadata so renderers don't
   * have to reach into a free-form bag to find them.
   */
  actions?: { type: string; [key: string]: unknown }[];
  /**
   * Free-form metadata bag for derivative info that isn't part of the message
   * body itself (delivery source, etc.). Prefer placing non-core fields here
   * over scattering them on the entry root.
   */
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface MemoryEntry {
  id: string;
  content: string;
  metadata: Record<string, unknown>;
  grants: unknown[];
  createdAt: string;
  updatedAt: string;
}

export interface MemoryAddInput {
  content: string;
  id?: string;
  metadata?: Record<string, unknown>;
  grants?: unknown[];
}

export interface MemoryUpdateInput {
  content?: string;
  metadata?: Record<string, unknown>;
  grants?: unknown[];
}

export interface MemorySearchOptions {
  limit?: number;
  filter?: Record<string, unknown>;
}

export type MessageRow = {
  role: 'user' | 'assistant' | 'error';
  content: string;
  ts: string;
  userId?: string;
};

export interface InstructionEntry {
  key: string;
  content: string;
  updatedAt: string;
}

export type UserRole = 'owner' | 'user' | 'guest';

export interface UserRecord {
  userId: string;
  name?: string;
  mergedInto?: string;
  createdAt: string;
  updatedAt: string;
}

export interface UserAgentRecord {
  userId: string;
  agentId: string;
  role: UserRole;
  createdAt: string;
}

export interface UserIdentity {
  userId: string;
  channel: string;
  channelUserId: string;
  createdAt: string;
}

export interface SkillRecord {
  id: string;
  name: string;
  description: string;
  path: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface AgentSkillRecord {
  agentId: string;
  skillId: string;
  enabled: boolean;
  createdAt: string;
}

// ── MCP Servers ─────────────────────────────────────────────────────

export interface McpServerRecord {
  id: string;
  name: string;
  description: string;
  url: string;
  headers?: Record<string, string>;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface AgentMcpServerRecord {
  agentId: string;
  mcpServerId: string;
  enabled: boolean;
  createdAt: string;
}

// ── Schedules ────────────────────────────────────────────────────────

export type ScheduleType = 'cron' | 'once';
export type ScheduleStatus = 'active' | 'paused' | 'completed' | 'failed';

export interface ScheduleDelivery {
  kind: 'silent' | 'session';
  sessionId?: string;
}

export interface SchedulePolicy {
  timeout_seconds?: number;
  max_iterations?: number;
  concurrency?: 'skip' | 'queue';
  model?: string;
}

export interface ScheduleRecord {
  agentId: string;
  scheduleId: string;
  type: ScheduleType;
  status: ScheduleStatus;
  cronExpression?: string;
  runAt?: string;
  prompt: string;
  delivery: ScheduleDelivery;
  policy: SchedulePolicy;
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
  nextRunAt?: string;
  runCount: number;
  consecutiveErrors: number;
  lastError?: string;
}

export interface ScheduleCreateInput {
  scheduleId?: string;
  type: ScheduleType;
  cronExpression?: string;
  runAt?: string;
  prompt: string;
  delivery?: ScheduleDelivery;
  policy?: SchedulePolicy;
  createdBy?: string;
}

export interface ScheduleUpdateInput {
  status?: ScheduleStatus;
  cronExpression?: string;
  runAt?: string;
  prompt?: string;
  delivery?: ScheduleDelivery;
  policy?: SchedulePolicy;
}

export type ScheduleRunStatus = 'running' | 'completed' | 'failed' | 'skipped';

export interface ScheduleRunRecord {
  id: number;
  agentId: string;
  scheduleId: string;
  status: ScheduleRunStatus;
  sessionId?: string;
  prompt: string;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  error?: string;
}
