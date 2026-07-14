import type { Agent, StreamFn } from '@mariozechner/pi-agent-core';
import type { MessageParticipant, SessionStatus } from '@openhermit/protocol';
import type { ApprovalRequestStore, AttachmentStorage, AttachmentStore, InternalStateStore, McpServerStore, PolicyStore, SandboxStore, SkillStore, UserRole } from '@openhermit/store';

import type { LangfuseClientLike, LangfuseTurnContext } from '../langfuse.js';
import type { SessionDescriptor } from '../runtime.js';
import type { ApprovalGate } from './approval-gate.js';
import type { SpeakerTagStreamState } from './message-utils.js';

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
  /** Mid-turn steering (`OPENHERMIT_MID_TURN_STEERING=1`): highest
   *  session_events id already visible to the in-flight turn. User rows
   *  appended after this id get folded into the running turn at the next
   *  tool boundary. Recaptured at every turn start. */
  midTurnCursor?: number;
  /** messageIds already folded into an in-flight turn via steer(). The
   *  queued postMessage turn for these ids becomes a no-op so a folded
   *  message is never processed twice. */
  foldedMessageIds?: Set<string>;
  /** messageIds folded during the current turn. Reset at turn start. If the
   *  turn fails before answering, these are removed from `foldedMessageIds`
   *  so their suppressed queued turns proceed rather than stranding the
   *  user with no response. */
  currentTurnFoldedIds?: Set<string>;
  /** Resolved userId of the message that started the in-flight turn, snapshotted
   *  when its tool principal is built. Mid-turn folding compares each candidate
   *  row's persisted userId against this: a message from a different principal
   *  must never fold into this turn (it would execute tools at this turn's
   *  privilege) and instead falls through to its own turn. */
  currentTurnPrincipalUserId?: string | undefined;
  /** messageId that started the in-flight turn. Excluded from mid-turn folding
   *  so the turn's own trigger is never re-injected when the fold cursor is
   *  captured before it is persisted. */
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
