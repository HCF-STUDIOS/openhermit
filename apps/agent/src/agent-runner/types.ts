import type { Agent, StreamFn } from '@mariozechner/pi-agent-core';
import type { SessionStatus } from '@openhermit/protocol';
import type { ApprovalRequestStore, AttachmentStorage, AttachmentStore, InternalStateStore, McpServerStore, PolicyStore, SandboxStore, SkillStore, UserRole } from '@openhermit/store';

import type { LangfuseClientLike, LangfuseTurnContext } from '../langfuse.js';
import type { SessionDescriptor } from '../runtime.js';
import type { ApprovalGate } from './approval-gate.js';

export interface RunnerSession extends SessionDescriptor {
  agent: Agent;
  queue: Promise<void>;
  sideEffects: Promise<void>;
  backgroundTasks: Promise<void>;
  checkpointInProgress: boolean;
  idleSummaryTimer: ReturnType<typeof setTimeout> | undefined;
  latestAssistantText: string | undefined;
  lastUserMessageText?: string;
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
