import type { Agent, StreamFn } from '@mariozechner/pi-agent-core';
import type { MessageParticipant, SessionStatus } from '@openhermit/protocol';
import type { ApprovalRequestStore, AttachmentStorage, AttachmentStore, InternalStateStore, McpServerStore, PolicyStore, SandboxStore, SkillStore, UserRole } from '@openhermit/store';

import type { LangfuseClientLike, LangfuseTurnContext } from '../langfuse.js';
import type { SessionDescriptor } from '../runtime.js';
import type { ApprovalGate } from './approval-gate.js';
import type { SpeakerTagStreamState } from './message-utils.js';

/** Principal bound to a single turn at post time and carried with its queued
 *  turn, so a turn always runs as the sender of ITS OWN triggering message,
 *  not whoever last posted into the shared session. Resolving tool
 *  authorization from shared session fields at run time let a queued guest turn
 *  snapshot a later owner post and run at owner privilege. */
export interface TurnPrincipal {
  userId?: string | undefined;
  role?: UserRole | undefined;
  userName?: string | undefined;
  channel?: string | undefined;
  channelUserId?: string | undefined;
}

export interface RunnerSession extends SessionDescriptor {
  agent: Agent;
  queue: Promise<void>;
  sideEffects: Promise<void>;
  backgroundTasks: Promise<void>;
  checkpointInProgress: boolean;
  idleSummaryTimer: ReturnType<typeof setTimeout> | undefined;
  latestAssistantText: string | undefined;
  lastUserMessageText?: string;
  // Sender names for stripping a copied `[Name]` tag from the reply. Group only.
  groupSenderNames?: Set<string>;
  // Per-turn snapshot of the group roster (set at run start) used to resolve
  // `@Name` mentions, so a concurrent later message cannot change it mid-reply.
  turnGroupParticipants?: MessageParticipant[] | undefined;
  speakerTagStream?: SpeakerTagStreamState | undefined;
  /** Inbound messageId of the user message that triggered the in-flight
   *  turn. Stamped onto every outbound event for that turn as
   *  `correlationId`, so callers can group events back to the originating
   *  user message. Cleared at agent_end. */
  currentTurnCorrelationId?: string;
  approvalGate: ApprovalGate;
  status: SessionStatus;
  messageCount: number;
  completedTurnCount: number;
  description?: string;
  descriptionSource?: 'fallback' | 'ai';
  lastMessagePreview?: string;
  resumed: boolean;
  userIds: string[];
  resolvedUserId?: string;
  resolvedUserRole?: UserRole;
  resolvedUserName?: string;
  resolvedChannel?: string;
  resolvedChannelUserId?: string;
  langfuseTurnContext?: LangfuseTurnContext;
  turnStartMs?: number;
  /** Consecutive failed tool results in the current turn. Resets at turn
   *  start and on any successful tool result. The agent aborts the turn
   *  when this reaches `MAX_CONSECUTIVE_TOOL_FAILURES` to prevent the
   *  model from looping forever against a broken tool. */
  consecutiveToolFailures: number;
  /** Resolved userId of the message that started the in-flight turn, snapshotted
   *  when its tool principal is built. The turn's principal snapshot, so a queued
   *  turn is authorized as its own sender, not whoever last posted. */
  currentTurnPrincipalUserId?: string | undefined;
  /** Resolved role of the in-flight turn's principal, snapshotted alongside
   *  currentTurnPrincipalUserId when the tool principal is built. */
  currentTurnPrincipalRole?: UserRole | undefined;
  /** messageId that started the in-flight turn. Stamped onto the turn's terminal
   *  agent_end so gateway streams and channel readers scope the end to it. */
  currentTurnTriggerMessageId?: string | undefined;
  /** correlationIds of `pending_media` skeletons emitted this turn that a
   *  matching `attachment` has not yet resolved. At turn end each survivor is
   *  cancelled so an uploaded-but-never-sent media never strands a permanent
   *  "generating" placeholder in consumers. */
  pendingMediaCorrelationIds?: Set<string>;
}

export interface AgentRunnerOptions {
  workspace: import('../core/index.js').AgentWorkspace;
  security: import('../core/index.js').AgentSecurity;
  store?: InternalStateStore;
  skillStore?: SkillStore;
  mcpServerStore?: McpServerStore;
  containerManager?: import('../core/index.js').DockerContainerManager;
  streamFn?: StreamFn;
  langfuse?: LangfuseClientLike;
  contextCompactionMaxTokens?: number;
  contextCompactionRecentMessageCount?: number;
  contextCompactionSummaryMaxChars?: number;
  contextCompactionMaxMessages?: number;
  /**
   * Sandbox store — when provided, ExecBackendManager loads backends from
   * sandbox rows (one per agent). Without it, AgentRunner falls back to
   * the legacy `config.exec.backends[]` path until backfill completes.
   */
  sandboxStore?: SandboxStore;
  policyStore?: PolicyStore;
  approvalRequestStore?: ApprovalRequestStore;
  attachmentStore?: AttachmentStore;
  attachmentStorage?: AttachmentStorage;
}
