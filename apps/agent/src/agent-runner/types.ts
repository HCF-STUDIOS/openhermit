import type { Agent, StreamFn } from '@mariozechner/pi-agent-core';
import type { MessageParticipant, SessionStatus } from '@openhermit/protocol';
import type { ApprovalRequestStore, AttachmentStorage, AttachmentStore, InternalStateStore, McpServerStore, PolicyStore, SandboxStore, SkillStore, UserRole } from '@openhermit/store';

import type { LangfuseClientLike, LangfuseTurnContext } from '../langfuse.js';
import type { SessionDescriptor } from '../runtime.js';
import type { ApprovalGate } from './approval-gate.js';
import type { ReasoningTagStreamState, SpeakerTagStreamState } from './message-utils.js';
import type { ModelErrorKind } from './user-facing-error.js';

export interface RunnerSession extends SessionDescriptor {
  agent: Agent;
  /** Detaches the current `agent`'s event listener (the return of
   *  `agent.subscribe`). Called before swapping in a rebuilt agent on
   *  force-release, so a late-firing event from the abandoned (hung) agent
   *  can never mutate the new turn's state. */
  agentUnsubscribe?: () => void;
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
  // Suppresses inline <think>/<thinking>/<reasoning> bodies on the live stream.
  reasoningTagStream?: ReasoningTagStreamState | undefined;
  /** Reasoning tag left unclosed by the previous assistant message of this
   *  turn; the next message's stream starts suppressed under it. */
  reasoningCarryTagName?: string | undefined;
  /** Inbound messageId of the user message that triggered the in-flight
   *  turn. Stamped onto every outbound event for that turn as
   *  `correlationId`, so callers can group events back to the originating
   *  user message. Cleared at agent_end. */
  currentTurnCorrelationId?: string;
  /** Text of the user message that triggered the in-flight turn. Used to
   *  phrase user-facing error notices in the user's own language. */
  currentTurnUserText?: string;
  /** Per-turn system-prompt steering supplied on the triggering message
   *  (`SessionMessage.additionalInstruction`). Appended to the system prompt
   *  for this turn's LLM call(s) only, then overwritten at the next turn's
   *  `refreshAgentConfiguration`. Never persisted to session history. */
  currentTurnAdditionalInstruction?: string | undefined;
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
  /** Per-turn inactivity watchdog. Armed at turn start, re-armed on every
   *  agent event, cleared when the turn settles. If no agent event arrives
   *  for `turnWatchdogMs`, the turn is presumed wedged (a model/tool await
   *  that never returns) and the watchdog calls `agent.abort()` to release
   *  the serial `session.queue`, which a hung turn would otherwise block
   *  forever. Undefined when no turn is in flight. */
  turnWatchdogTimer?: ReturnType<typeof setTimeout> | undefined;
  /** Grace timer armed when the watchdog fires `agent.abort()`. If the wedged
   *  await ignores the abort signal (e.g. an MCP tool call that never returns),
   *  the turn never settles and the serial `session.queue` stays blocked
   *  forever — previously unrecoverable without a process restart. When this
   *  fires and the turn is still running, the session is force-released (queue
   *  reset, status → idle) so later messages can run. Undefined otherwise. */
  turnForceReleaseTimer?: ReturnType<typeof setTimeout> | undefined;
  /** Consecutive failed tool results in the current turn. Resets at turn
   *  start and on any successful tool result. The agent aborts the turn
   *  when this reaches `MAX_CONSECUTIVE_TOOL_FAILURES` to prevent the
   *  model from looping forever against a broken tool. */
  consecutiveToolFailures: number;
  /** Set at message_end when the turn ended in a model error
   *  (`stopReason==='error'`), cleared at turn start. `runScheduledJob` reads
   *  it so a cron run that produced no reply is recorded as a *failed* run
   *  (→ scheduler exponential backoff, auto-recovering on the next success)
   *  instead of a silent success that keeps re-firing at full cadence — the
   *  behaviour that turned an account-wide 402 outage into a per-tick storm. */
  lastTurnModelError?: { kind: ModelErrorKind; message: string };
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
  /**
   * Eviction fence for detached research phases: acquire before a phase
   * starts executing, release when it settles. Wired by the gateway's
   * AgentInstanceManager so an idle-LRU sweep cannot evict a runner that is
   * actively planning/researching/synthesizing.
   */
  acquireResearchBusy?: () => () => void;
}
