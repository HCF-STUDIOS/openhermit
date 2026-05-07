import type { AgentTool } from '@mariozechner/pi-agent-core';
import type { TSchema } from 'typebox';
import type { ChannelOutbound } from '@openhermit/protocol';
import { ValidationError } from '@openhermit/shared';
import type { InstructionStore, MemoryProvider, MessageStore, PolicyStore, ScheduleStore, SessionStore, StoreScope, UserStore } from '@openhermit/store';

import { AgentSecurity, type ExecBackendManager, type ToolPolicy } from '../core/index.js';
import type { WebProvider } from '../web/index.js';

export interface PolicyAwareTool<TParameters extends TSchema = TSchema, TDetails = any> extends AgentTool<TParameters, TDetails> {
  policy?: ToolPolicy;
}

export interface Toolset {
  id: string;
  description: string;
  tools: PolicyAwareTool[];
}

export type ApprovalDecision = 'approved' | 'rejected' | 'timed_out' | 'cancelled';

export type ApprovalCallback = (
  toolName: string,
  toolCallId: string,
  args: unknown,
) => Promise<ApprovalDecision>;

export type ToolCallCallback = (
  toolName: string,
  toolCallId: string,
  args: unknown,
) => Promise<void> | void;

export interface ToolContext {
  security: AgentSecurity;
  memoryProvider?: MemoryProvider;
  messageStore?: MessageStore | undefined;
  sessionStore?: SessionStore | undefined;
  sessionId?: string | undefined;
  currentUserId?: string | undefined;
  /** Role of the user the agent is currently acting on behalf of. Tools
   * that surface cross-user information (e.g. session_list) widen their
   * visibility when role === 'owner'. */
  currentUserRole?: 'owner' | 'user' | 'guest' | undefined;
  /** Channel of the current caller (e.g. 'telegram', 'cli', 'web'). Used by
   * identity-link tools to know which channel a confirmation is coming from. */
  currentChannel?: string | undefined;
  /** Platform-specific user id of the current caller on `currentChannel`. */
  currentChannelUserId?: string | undefined;
  webProvider?: WebProvider | undefined;
  instructionStore?: InstructionStore;
  userStore?: UserStore;
  storeScope?: StoreScope;
  agentId?: string;
  execBackendManager?: ExecBackendManager;
  scheduleStore?: ScheduleStore;
  policyStore?: PolicyStore;
  approvalRequestStore?: import('@openhermit/store').ApprovalRequestStore;
  /** Channel outbound adapters keyed by channel name (e.g. 'telegram'). */
  channelOutbound?: Map<string, ChannelOutbound>;
  onExec?: () => void;
  approvalCallback?: ApprovalCallback;
  approvedCache?: Set<string>;
  onToolCall?: ToolCallCallback;
  /** Optional plugin/hook bus — when supplied, every tool call goes
   * through tool.before@v1 (vetoable) and tool.after@v1 (listener). */
  hookBus?: import('../events.js').AgentEventBus;
  /** When set, called after an async ApprovalRequest is created to notify
   *  the owner via their configured notification channel. */
  notifyOwnerApproval?: (requestId: string, resourceType: string, resourceKey: string, requesterId: string, requesterSessionId: string) => Promise<void>;
  /** Publish an SSE event to the session's event stream. */
  publishEvent?: (event: Record<string, unknown>) => void;
}

/** Maximum characters for a single tool result text block (~256 KB). */
const MAX_TOOL_RESULT_CHARS = 256_000;

export const asTextContent = (text: string) => {
  const truncated = text.length > MAX_TOOL_RESULT_CHARS
    ? text.slice(0, MAX_TOOL_RESULT_CHARS)
      + `\n\n[truncated: output was ${text.length.toLocaleString()} chars, kept first ${MAX_TOOL_RESULT_CHARS.toLocaleString()}]`
    : text;
  return [
    {
      type: 'text' as const,
      text: truncated,
    },
  ];
};

export const formatJson = (value: unknown): string =>
  `${JSON.stringify(value, null, 2)}\n`;

export class ApprovalRequiredError extends Error {
  constructor(
    public readonly requestId: string,
    public readonly resourceType: string,
    public readonly resourceKey: string,
  ) {
    super(
      `BLOCKED: Access to ${resourceType}/${resourceKey} requires owner approval (request id: ${requestId}). `
      + `The owner has been notified. `
      + `You MUST stop here and tell the user that this action requires owner approval. `
      + `Do NOT attempt to achieve the same goal through alternative tools or workarounds.`,
    );
    this.name = 'ApprovalRequiredError';
  }
}

/**
 * When evaluateAccess returns 'require_approval', check for an existing
 * approved request. If found, allow. When approvalCallback is available
 * (real-time session), use it for in-session approval. Otherwise create
 * a persistent request and throw ApprovalRequiredError.
 */
export const checkApprovalOrRequest = async (
  context: ToolContext,
  resourceType: string,
  resourceKey: string,
  scope?: Record<string, unknown>,
): Promise<void> => {
  if (!context.approvalRequestStore || !context.storeScope || !context.currentUserId) {
    throw new ValidationError(
      `Access to ${resourceType}/${resourceKey} requires approval, but no approval store is configured.`,
    );
  }

  const approved = await context.approvalRequestStore.findApproved(
    context.storeScope.agentId,
    context.currentUserId,
    resourceType,
    resourceKey,
  );
  if (approved) return;

  // Real-time approval: owner is in an interactive session
  if (context.approvalCallback) {
    const request = await context.approvalRequestStore.create({
      agentId: context.storeScope.agentId,
      sessionId: context.sessionId ?? 'unknown',
      requesterId: context.currentUserId,
      resourceType,
      resourceKey,
      ...(scope ? { scope } : {}),
    });

    const decision = await context.approvalCallback(
      `${resourceType}:${resourceKey}`,
      request.id,
      scope ?? {},
    );

    const dbDecision = decision === 'approved' ? 'approved' : 'rejected';
    context.approvalRequestStore
      .resolve(request.id, dbDecision, context.currentUserId, 'once')
      .catch(() => {});

    if (decision === 'rejected' || decision === 'timed_out' || decision === 'cancelled') {
      throw new ValidationError(
        `Access to ${resourceType}/${resourceKey} was ${decision} by the user.`,
      );
    }
    return;
  }

  // Async approval: create a persistent request for owner to review
  const request = await context.approvalRequestStore.create({
    agentId: context.storeScope.agentId,
    sessionId: context.sessionId ?? 'unknown',
    requesterId: context.currentUserId,
    resourceType,
    resourceKey,
    ...(scope ? { scope } : {}),
  });

  if (context.publishEvent && context.sessionId) {
    context.publishEvent({
      type: 'approval_requested',
      sessionId: context.sessionId,
      requestId: request.id,
      resourceType,
      resourceKey,
      mode: 'async',
    });
  }

  if (context.notifyOwnerApproval) {
    context.notifyOwnerApproval(request.id, resourceType, resourceKey, context.currentUserId, context.sessionId ?? 'unknown').catch(() => {});
  }

  throw new ApprovalRequiredError(request.id, resourceType, resourceKey);
};
