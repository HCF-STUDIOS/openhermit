export type KnownSourceKind = 'cli' | 'api' | 'channel' | 'schedule';

export type SourceKind = KnownSourceKind | (string & {});

export type MetadataValue = string | number | boolean;

export type SessionType = 'direct' | 'group';

export interface SessionSource {
  kind: SourceKind;
  interactive: boolean;
  platform?: string;
  triggerId?: string;
  type?: SessionType;
}

export interface MessageSender {
  channel: string;
  channelUserId: string;
  displayName?: string;
}

export interface SessionSpec {
  sessionId: string;
  source: SessionSource;
  metadata?: Record<string, MetadataValue>;
  /**
   * Optional per-session prompt addendum stored on the session row at
   * create time. When non-empty, the runner appends it to the system
   * prompt as a dedicated section after agent-level instructions.
   * Immutable for the life of the session.
   */
  customInstruction?: string;
}

export interface SessionAttachment {
  type: string;
  url?: string;
  data?: string;
}

export interface SessionMessage {
  messageId?: string;
  text: string;
  attachments?: SessionAttachment[];
  sender?: MessageSender;
  metadata?: Record<string, unknown>;
  /** Whether the bot was explicitly mentioned. When false in a group session,
   *  the server may inject instead of prompting based on user role. */
  mentioned?: boolean;
}

export type SessionHistoryRole = 'user' | 'assistant' | 'error' | 'tool' | 'introspection';

export interface SessionHistoryMessage {
  ts: string;
  role: SessionHistoryRole;
  content: string;
  name?: string;
  messageId?: string;
  attachments?: SessionAttachment[];
  provider?: string;
  model?: string;
  stopReason?: string;
  thinking?: string;
  tool?: string;
  toolCallId?: string;
  toolPhase?: 'call' | 'result';
  toolIsError?: boolean;
  toolArgs?: unknown;
  /** True for tool_call/tool_result entries emitted as part of an introspection turn. */
  introspection?: boolean;
  introspectionPhase?: 'start' | 'end';
  introspectionSummary?: string;
  /** Per-message metadata supplied by the caller on user turns. Persisted
   *  alongside the log entry; surfaced for plugins/tools, not the model. */
  metadata?: Record<string, unknown>;
}

export type SessionStatus = 'idle' | 'running' | 'awaiting_approval' | 'inactive';

export interface SessionSummary {
  sessionId: string;
  source: SessionSource;
  createdAt: string;
  lastActivityAt: string;
  lastEventId: number;
  messageCount: number;
  description?: string;
  lastMessagePreview?: string;
  status: SessionStatus;
  metadata?: Record<string, MetadataValue>;
}

export interface SessionListQuery {
  kind?: SourceKind;
  platform?: string;
  interactive?: boolean;
  limit?: number;
  /** Filter by session ID prefix (e.g. "telegram:" to match a channel namespace). */
  channel?: string;
  /** Filter by metadata key-value pairs (e.g. { telegram_chat_id: "123" }). */
  metadata?: Record<string, string>;
  /** Include inactive sessions (replaced by /new). Default false. */
  includeInactive?: boolean;
}

/**
 * Identity of the caller making a WS/HTTP request.
 * Used to resolve the internal userId before session operations.
 * Channels attach this based on their authentication mechanism
 * (e.g. Telegram user_id, web device UUID, OS username for CLI).
 */
export interface CallerIdentity {
  channel: string;
  channelUserId: string;
}

export const isCallerIdentity = (value: unknown): value is CallerIdentity =>
  isRecord(value) &&
  typeof value.channel === 'string' &&
  typeof value.channelUserId === 'string';

/**
 * Body of an outbound event without the per-event identifier. Producers emit
 * this shape; the runtime mints `eventId` before delivering to consumers.
 *
 * `correlationId` (where present) is the inbound user-message id that
 * triggered the turn. It is NOT a per-event id — multiple events in the same
 * turn share the same `correlationId`. Consumers persisting events by id
 * MUST use `eventId` (added by the runtime), not `correlationId`.
 */
export type OutboundEventBody =
  | { type: 'thinking_delta'; sessionId: string; text: string; correlationId?: string }
  | { type: 'thinking_final'; sessionId: string; text: string; correlationId?: string }
  | { type: 'text_delta'; sessionId: string; text: string; correlationId?: string }
  | { type: 'text_final'; sessionId: string; text: string; correlationId?: string }
  | { type: 'tool_call'; sessionId: string; tool: string; toolCallId: string; args?: unknown; correlationId?: string }
  | {
      type: 'tool_result';
      sessionId: string;
      tool: string;
      toolCallId: string;
      isError: boolean;
      text?: string;
      details?: unknown;
      correlationId?: string;
    }
  | {
      type: 'approval_requested';
      sessionId: string;
      requestId?: string;
      resourceType: string;
      resourceKey: string;
      toolCallId?: string;
      args?: unknown;
      mode: 'realtime' | 'async';
    }
  | {
      type: 'approval_pending';
      sessionId: string;
      requestId?: string;
      resourceType: string;
      resourceKey: string;
      requesterId: string;
      requesterSessionId: string;
      args?: unknown;
      mode: 'async';
    }
  | {
      type: 'approval_resolved';
      sessionId: string;
      requestId?: string;
      resourceType: string;
      resourceKey: string;
      toolCallId?: string;
      decision: 'approved' | 'rejected' | 'timed_out' | 'cancelled';
      resolution?: 'once' | 'persistent';
      reviewerId?: string;
      mode: 'realtime' | 'async';
    }
  | { type: 'user_message'; sessionId: string; text: string; name?: string }
  | { type: 'agent_start'; sessionId: string; correlationId?: string }
  | { type: 'agent_end'; sessionId: string }
  | { type: 'error'; sessionId: string; message: string };

export type OutboundEvent = OutboundEventBody & { eventId: string };

// ── Channel Outbound ──────────────────────────────────────────────────

export interface ChannelOutboundResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

export interface ChannelMessageAction {
  type: 'approval_review';
  requestId: string;
  shortId: number;
  label?: string;
}

/**
 * Interface for channel adapters that support outbound (proactive) messaging.
 * Implementations send the message via the channel API. The caller (e.g. the
 * `session_send` tool) is responsible for recording the delivery as an
 * assistant log entry in the target session.
 */
export interface ChannelOutbound {
  readonly channel: string;
  send(params: {
    sessionId: string;
    to: string;
    text: string;
    actions?: ChannelMessageAction[];
  }): Promise<ChannelOutboundResult>;
}

export interface ToolApprovalRequest {
  toolCallId: string;
  approved: boolean;
}

export interface SessionCheckpointRequest {
  reason?: 'manual' | 'new_session' | 'turn_limit' | 'idle';
}

export const agentLocalRoutes = {
  health: '/health',
  sessions: '/sessions',
  sessionEventsPattern: '/sessions/:sessionId/events',
  sessionEvents: (sessionId: string): string =>
    `/sessions/${encodeURIComponent(sessionId)}/events`,
  sessionMessagesPattern: '/sessions/:sessionId/messages',
  sessionMessages: (sessionId: string): string =>
    `/sessions/${encodeURIComponent(sessionId)}/messages`,
  sessionApprovePattern: '/sessions/:sessionId/approve',
  sessionApprove: (sessionId: string): string =>
    `/sessions/${encodeURIComponent(sessionId)}/approve`,
  sessionCheckpointPattern: '/sessions/:sessionId/checkpoint',
  sessionCheckpoint: (sessionId: string): string =>
    `/sessions/${encodeURIComponent(sessionId)}/checkpoint`,
  eventsUrl: (sessionId: string): string =>
    `/sessions/${encodeURIComponent(sessionId)}/events`,
  ws: '/ws',
} as const;

export type AgentStatus =
  | 'registered'
  | 'starting'
  | 'running'
  | 'stopped'
  | 'error';

export interface AgentInfo {
  agentId: string;
  status: AgentStatus;
  name?: string;
  workspaceDir?: string;
  port?: number;
  error?: string;
}

export interface CreateAgentRequest {
  agentId: string;
  name?: string;
  workspaceDir?: string;
  ownerUserId?: string;
  /**
   * Sandbox provisioning at create time:
   * - omitted: auto-provision using the gateway's configured default preset
   * - string : provision using the named preset
   * - null   : do not provision any sandbox
   */
  sandbox?: string | null;
  /**
   * Initial access level written into the agent's security policy.
   * Defaults to 'public' if omitted. For 'protected', set the
   * access_token afterwards via the security policy endpoint.
   */
  access?: 'public' | 'protected' | 'private';
}

export const gatewayRoutes = {
  agents: '/api/agents',
  agentHealth: (agentId: string): string =>
    `/api/agents/${encodeURIComponent(agentId)}/health`,
  agentHealthPattern: '/api/agents/:agentId/health',
  agentSessions: (agentId: string): string =>
    `/api/agents/${encodeURIComponent(agentId)}/sessions`,
  agentSessionsPattern: '/api/agents/:agentId/sessions',
  agentSessionMessages: (agentId: string, sessionId: string): string =>
    `/api/agents/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(sessionId)}/messages`,
  agentSessionMessagesPattern:
    '/api/agents/:agentId/sessions/:sessionId/messages',
  agentSessionEvents: (agentId: string, sessionId: string): string =>
    `/api/agents/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(sessionId)}/events`,
  agentSessionEventsPattern:
    '/api/agents/:agentId/sessions/:sessionId/events',
  agentSessionApprove: (agentId: string, sessionId: string): string =>
    `/api/agents/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(sessionId)}/approve`,
  agentSessionApprovePattern:
    '/api/agents/:agentId/sessions/:sessionId/approve',
  agentSessionCheckpoint: (agentId: string, sessionId: string): string =>
    `/api/agents/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(sessionId)}/checkpoint`,
  agentSessionCheckpointPattern:
    '/api/agents/:agentId/sessions/:sessionId/checkpoint',
  agentManage: (agentId: string, action: string): string =>
    `/api/agents/${encodeURIComponent(agentId)}/manage/${encodeURIComponent(action)}`,
  agentManagePattern: '/api/agents/:agentId/manage/:action',

  /** Sandbox CRUD per agent. */
  agentSandboxes: (agentId: string): string =>
    `/api/agents/${encodeURIComponent(agentId)}/sandboxes`,
  agentSandboxesPattern: '/api/agents/:agentId/sandboxes',
  agentSandboxByAlias: (agentId: string, alias: string): string =>
    `/api/agents/${encodeURIComponent(agentId)}/sandboxes/${encodeURIComponent(alias)}`,
  agentSandboxByAliasPattern: '/api/agents/:agentId/sandboxes/:alias',

  /** Gateway-level token exchange (device key → user JWT). */
  authToken: '/api/auth/token',
  /** Admin-only global user create (CLI bootstrap). */
  users: '/api/users',
  /** Membership ops on an agent. */
  agentMembers: (agentId: string): string =>
    `/api/agents/${encodeURIComponent(agentId)}/members`,
  agentMemberByUser: (agentId: string, userId: string): string =>
    `/api/agents/${encodeURIComponent(agentId)}/members/${encodeURIComponent(userId)}`,
  /** List the current JWT subject's agent memberships. */
  meAgents: '/api/users/me/agents',
} as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isMetadataValue = (value: unknown): value is MetadataValue =>
  typeof value === 'string' ||
  typeof value === 'number' ||
  typeof value === 'boolean';

const isAttachment = (value: unknown): value is SessionAttachment => {
  if (!isRecord(value) || typeof value.type !== 'string') {
    return false;
  }

  if (value.url !== undefined && typeof value.url !== 'string') {
    return false;
  }

  if (value.data !== undefined && typeof value.data !== 'string') {
    return false;
  }

  return true;
};

export const isSessionSpec = (value: unknown): value is SessionSpec => {
  if (!isRecord(value) || typeof value.sessionId !== 'string') {
    return false;
  }

  if (!isRecord(value.source)) {
    return false;
  }

  if (
    typeof value.source.kind !== 'string' ||
    typeof value.source.interactive !== 'boolean'
  ) {
    return false;
  }

  if (
    value.source.platform !== undefined &&
    typeof value.source.platform !== 'string'
  ) {
    return false;
  }

  if (
    value.source.triggerId !== undefined &&
    typeof value.source.triggerId !== 'string'
  ) {
    return false;
  }

  if (
    value.source.type !== undefined &&
    value.source.type !== 'direct' &&
    value.source.type !== 'group'
  ) {
    return false;
  }

  if (value.metadata !== undefined) {
    if (!isRecord(value.metadata)) {
      return false;
    }

    for (const metadataValue of Object.values(value.metadata)) {
      if (!isMetadataValue(metadataValue)) {
        return false;
      }
    }
  }

  if (value.customInstruction !== undefined && typeof value.customInstruction !== 'string') {
    return false;
  }

  return true;
};

const isSender = (value: unknown): value is MessageSender => {
  if (!isRecord(value)) return false;
  if (typeof value.channel !== 'string' || typeof value.channelUserId !== 'string') return false;
  if (value.displayName !== undefined && typeof value.displayName !== 'string') return false;
  return true;
};

export const isSessionMessage = (value: unknown): value is SessionMessage => {
  if (!isRecord(value) || typeof value.text !== 'string') {
    return false;
  }

  if (value.messageId !== undefined && typeof value.messageId !== 'string') {
    return false;
  }

  if (value.sender !== undefined && !isSender(value.sender)) {
    return false;
  }

  if (value.attachments !== undefined) {
    if (!Array.isArray(value.attachments)) {
      return false;
    }

    if (!value.attachments.every(isAttachment)) {
      return false;
    }
  }

  if (value.metadata !== undefined) {
    if (!isRecord(value.metadata) || Array.isArray(value.metadata)) {
      return false;
    }
  }

  return true;
};

export const createTextFinalEvent = (
  sessionId: string,
  text: string,
): OutboundEventBody => ({
  type: 'text_final',
  sessionId,
  text,
});

export const createAgentEndEvent = (sessionId: string): OutboundEventBody => ({
  type: 'agent_end',
  sessionId,
});

export const isToolApprovalRequest = (
  value: unknown,
): value is ToolApprovalRequest => {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.toolCallId === 'string' &&
    typeof value.approved === 'boolean'
  );
};

// ---------------------------------------------------------------------------
// HTTP sync response (POST /sessions/:id/messages?wait=true)
// ---------------------------------------------------------------------------

export interface SyncToolCall {
  tool: string;
  args?: unknown;
  isError: boolean;
  text?: string;
  details?: unknown;
}

export interface SyncResponse {
  sessionId: string;
  messageId?: string;
  text: string | null;
  toolCalls: SyncToolCall[];
  error?: string;
}

// ---------------------------------------------------------------------------
// WebSocket protocol
// ---------------------------------------------------------------------------

export type WsMethod =
  | 'session.open'
  | 'session.message'
  | 'session.approve'
  | 'session.checkpoint'
  | 'session.delete'
  | 'session.list'
  | 'session.history'
  | 'session.subscribe'
  | 'session.unsubscribe';

export interface WsRequest {
  kind: 'request';
  id: string;
  method: WsMethod;
  params?: Record<string, unknown>;
}

export interface WsResponseOk {
  kind: 'response';
  id: string;
  result: unknown;
}

export interface WsResponseError {
  kind: 'response';
  id: string;
  error: { code: WsErrorCode; message: string };
}

export type WsResponse = WsResponseOk | WsResponseError;

export type WsErrorCode =
  | 'INVALID_PARAMS'
  | 'SESSION_NOT_FOUND'
  | 'NOT_SUBSCRIBED'
  | 'UNAUTHORIZED'
  | 'INTERNAL_ERROR';

export interface WsEvent {
  kind: 'event';
  eventId: number;
  sessionId: string;
  event: OutboundEvent;
}

export type WsServerMessage = WsResponse | WsEvent;
export type WsClientMessage = WsRequest;

export const isWsRequest = (value: unknown): value is WsRequest => {
  if (!isRecord(value)) return false;
  return value.kind === 'request' && typeof value.id === 'string' && typeof value.method === 'string';
};

export const isSessionCheckpointRequest = (
  value: unknown,
): value is SessionCheckpointRequest => {
  if (value === null) {
    return true;
  }

  if (!isRecord(value)) {
    return false;
  }

  if (value.reason === undefined) {
    return true;
  }

  return (
    value.reason === 'manual' ||
    value.reason === 'new_session' ||
    value.reason === 'turn_limit' ||
    value.reason === 'idle'
  );
};
