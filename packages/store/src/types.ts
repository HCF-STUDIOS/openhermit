import type {
  MetadataValue,
  SessionHistoryMessage,
  SessionSource,
  SessionSpec,
  SessionStatus,
  SessionType,
  SandboxType,
} from '@openhermit/protocol';

export type { SandboxType } from '@openhermit/protocol';

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

export type SkillSource = 'system' | 'user';

export interface SkillRecord {
  /**
   * Opaque storage id. For system skills this equals `slug`. For user skills
   * it is encoded as `user:<ownerAgentId>:<slug>` so the same slug can
   * coexist across owners. Consumers should not parse this; use `slug` for
   * the user-visible identifier (folder name, prompt index).
   */
  id: string;
  /** User-visible identifier — folder name and prompt-index id. */
  slug: string;
  name: string;
  description: string;
  path: string;
  source: SkillSource;
  /** Required when source='user'; identifies the agent that installed it. */
  ownerAgentId?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

/**
 * Compute the storage id for a skill. System skills use the slug as-is so
 * existing rows and the operator-facing CLI continue to work. User skills
 * embed the owner so multiple agents can install a skill with the same slug.
 */
export const skillStorageId = (
  source: SkillSource,
  slug: string,
  ownerAgentId: string | undefined,
): string => {
  if (source === 'user') {
    if (!ownerAgentId) {
      throw new Error('User skills require ownerAgentId to derive a storage id.');
    }
    return `user:${ownerAgentId}:${slug}`;
  }
  return slug;
};

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

/**
 * How firings of a schedule map onto sessions.
 *
 * - `dedicated` — every firing of this schedule writes to the same
 *   long-lived session `schedule:<id>`. Useful when the agent should
 *   accumulate context across firings (e.g. "compare today's metrics to
 *   yesterday's"). Watch out for unbounded history growth.
 * - `ephemeral` — every firing opens a fresh session
 *   `schedule:<id>:<iso-ts>` that is torn down at the end of the firing.
 *   Use for stateless work (feed scans, periodic notifications) to keep
 *   per-firing token cost bounded.
 */
export interface ScheduleSessionMode {
  kind: 'dedicated' | 'ephemeral';
}

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
  sessionMode: ScheduleSessionMode;
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
  sessionMode?: ScheduleSessionMode;
  delivery?: ScheduleDelivery;
  policy?: SchedulePolicy;
  createdBy?: string;
}

export interface ScheduleUpdateInput {
  status?: ScheduleStatus;
  cronExpression?: string;
  runAt?: string;
  prompt?: string;
  sessionMode?: ScheduleSessionMode;
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

// ─── Deep Research (docs/deep-research-design.md §18) ───────────────────────
// JSON blob columns (plan, source policy, budgets, usage, working state,
// report, locators, quality) are validated and typed by the agent runtime;
// the store treats them as opaque objects.

export type ResearchRunStatus =
  | 'created'
  | 'planning'
  | 'awaiting_plan_approval'
  | 'queued'
  | 'researching'
  | 'synthesizing'
  | 'paused'
  | 'completed'
  | 'cancelled'
  | 'failed'
  | 'budget_exhausted';

export type ResearchResumePhase = 'planning' | 'researching' | 'synthesizing';

export type ResearchStepStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'interrupted'
  | 'cancelled'
  | 'invalidated';

export type ResearchSourceStatus =
  | 'candidate'
  | 'fetched'
  | 'blocked'
  | 'failed'
  | 'unsupported'
  | 'duplicate';

export interface ResearchRunRecord {
  runId: string;
  agentId: string;
  sessionId: string;
  requestedByUserId: string | null;
  clientRequestId: string | null;
  status: ResearchRunStatus;
  resumePhase: ResearchResumePhase | null;
  terminalReason: string | null;
  depth: string;
  objective: string;
  planJson: Record<string, unknown> | null;
  planVersion: number;
  sourcePolicyJson: Record<string, unknown>;
  budgetJson: Record<string, unknown>;
  usageJson: Record<string, unknown>;
  workingStateJson: Record<string, unknown>;
  reportJson: Record<string, unknown> | null;
  pauseRequested: boolean;
  cancelRequested: boolean;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface ResearchRunCreateInput {
  runId?: string;
  agentId: string;
  sessionId: string;
  requestedByUserId?: string | null;
  clientRequestId?: string | null;
  depth: string;
  objective: string;
  sourcePolicyJson: Record<string, unknown>;
  budgetJson: Record<string, unknown>;
}

export interface ResearchRunPatch {
  status?: ResearchRunStatus;
  resumePhase?: ResearchResumePhase | null;
  terminalReason?: string | null;
  planJson?: Record<string, unknown>;
  planVersion?: number;
  sourcePolicyJson?: Record<string, unknown>;
  budgetJson?: Record<string, unknown>;
  usageJson?: Record<string, unknown>;
  workingStateJson?: Record<string, unknown>;
  reportJson?: Record<string, unknown> | null;
  pauseRequested?: boolean;
  cancelRequested?: boolean;
  lastError?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
}

export interface ResearchStepRecord {
  stepId: string;
  runId: string;
  agentId: string;
  iteration: number;
  attempt: number;
  kind: string;
  status: ResearchStepStatus;
  dedupeKey: string;
  questionIds: string[];
  inputJson: Record<string, unknown>;
  outputJson: Record<string, unknown>;
  usageJson: Record<string, unknown>;
  summary: string | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface ResearchStepCreateInput {
  stepId?: string;
  runId: string;
  agentId: string;
  iteration: number;
  kind: string;
  dedupeKey: string;
  questionIds?: string[];
  inputJson?: Record<string, unknown>;
  summary?: string | null;
}

export interface ResearchStepPatch {
  status?: ResearchStepStatus;
  attempt?: number;
  outputJson?: Record<string, unknown>;
  usageJson?: Record<string, unknown>;
  summary?: string | null;
  error?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
}

export interface ResearchSourceRecord {
  sourceId: string;
  runId: string;
  agentId: string;
  kind: string;
  status: ResearchSourceStatus;
  url: string | null;
  canonicalUrl: string | null;
  canonicalUrlHash: string | null;
  title: string | null;
  publisher: string | null;
  domain: string | null;
  author: string | null;
  publishedAt: string | null;
  retrievedAt: string | null;
  mimeType: string | null;
  sourceClass: string;
  qualityJson: Record<string, unknown>;
  metadataJson: Record<string, unknown>;
  discoveredByStepId: string;
  snapshotText: string | null;
  contentHash: string | null;
  contentBytes: number | null;
  truncated: boolean;
  duplicateOfSourceId: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ResearchSourceCreateInput {
  sourceId?: string;
  runId: string;
  agentId: string;
  kind?: string;
  url?: string | null;
  canonicalUrl?: string | null;
  canonicalUrlHash?: string | null;
  title?: string | null;
  publisher?: string | null;
  domain?: string | null;
  publishedAt?: string | null;
  metadataJson?: Record<string, unknown>;
  discoveredByStepId: string;
}

export interface ResearchSourcePatch {
  status?: ResearchSourceStatus;
  url?: string | null;
  canonicalUrl?: string | null;
  canonicalUrlHash?: string | null;
  title?: string | null;
  publisher?: string | null;
  domain?: string | null;
  author?: string | null;
  publishedAt?: string | null;
  retrievedAt?: string | null;
  mimeType?: string | null;
  sourceClass?: string;
  qualityJson?: Record<string, unknown>;
  metadataJson?: Record<string, unknown>;
  snapshotText?: string | null;
  contentHash?: string | null;
  contentBytes?: number | null;
  truncated?: boolean;
  duplicateOfSourceId?: string | null;
  lastError?: string | null;
}

export interface ResearchEvidenceRecord {
  evidenceId: string;
  runId: string;
  agentId: string;
  sourceId: string;
  extractionStepId: string;
  questionIds: string[];
  excerpt: string;
  locatorJson: Record<string, unknown>;
  claimKey: string | null;
  stance: string;
  normalizedValue: string | null;
  scopeJson: Record<string, unknown>;
  relevanceBasisPoints: number;
  confidenceBasisPoints: number;
  outOfScope: boolean;
  evidenceHash: string;
  createdAt: string;
}

export interface ResearchEvidenceCreateInput {
  evidenceId?: string;
  runId: string;
  agentId: string;
  sourceId: string;
  extractionStepId: string;
  questionIds: string[];
  excerpt: string;
  locatorJson: Record<string, unknown>;
  claimKey?: string | null;
  stance: string;
  normalizedValue?: string | null;
  scopeJson?: Record<string, unknown>;
  relevanceBasisPoints?: number;
  confidenceBasisPoints?: number;
  evidenceHash: string;
}
