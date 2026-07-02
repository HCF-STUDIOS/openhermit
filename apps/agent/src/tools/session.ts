import { Type, type Static } from '@mariozechner/pi-ai';
import type { ChannelOutbound } from '@openhermit/protocol';
import { ValidationError } from '@openhermit/shared';

import {
  type PolicyAwareTool,
  type Toolset,
  type ToolContext,
  asTextContent,
  formatJson,
} from './shared.js';

// ── Parameters ──────────────────────────────────────────────────────

const SessionListParams = Type.Object({
  channel: Type.Optional(Type.String({ description: 'Filter by channel/platform (e.g. "telegram", "wechat", "web").' })),
  type: Type.Optional(Type.String({ description: 'Filter by session type: "direct" or "group".' })),
  user_id: Type.Optional(Type.String({ description: 'Only sessions that involve this OpenHermit user id.' })),
  search: Type.Optional(Type.String({ description: 'Case-insensitive substring match over description, last message preview, counterpart, and session id.' })),
  include_inactive: Type.Optional(Type.Boolean({ description: 'Include inactive sessions that were replaced by /new (default false).' })),
  limit: Type.Optional(Type.Number({ description: 'Page size (default 20, max 100).' })),
  offset: Type.Optional(Type.Number({ description: 'Number of sessions to skip for pagination (default 0). Results are ordered by most-recent activity first.' })),
});

type SessionListArgs = Static<typeof SessionListParams>;

/** Trim a value to a non-empty string, or undefined. */
const asStr = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim() : v != null && typeof v === 'number' ? String(v) : undefined;

/**
 * Human-readable label for the session's counterpart, derived from the
 * channel-specific identity fields each bridge writes into session metadata.
 * Returns undefined when nothing identifying is present.
 */
const describeCounterpart = (
  platform: string | undefined,
  md: Record<string, unknown> | undefined,
): string | undefined => {
  const m = md ?? {};
  switch (platform) {
    case 'telegram': {
      const title = asStr(m.telegram_chat_title);
      if (title) return title;
      const name = asStr(m.telegram_first_name);
      const user = asStr(m.telegram_username);
      const id = asStr(m.telegram_user_id);
      if (name && user) return `${name} (@${user})`;
      return name ?? (user ? `@${user}` : id);
    }
    case 'wechat': {
      const group = asStr(m.wechat_group_id);
      if (group) return `group ${group}`;
      return asStr(m.wechat_from_user_id) ?? asStr(m.wechat_peer_id);
    }
    case 'signal':
      return asStr(m.signal_source_number) ?? asStr(m.signal_source);
    case 'whatsapp':
      return asStr(m.whatsapp_group_jid) ?? asStr(m.whatsapp_sender_number) ?? asStr(m.whatsapp_chat_jid);
    case 'slack':
      return asStr(m.slack_channel_id ?? m.slack_user_id);
    case 'discord':
      return asStr(m.discord_channel_id);
    default:
      return undefined;
  }
};

const SessionReadParams = Type.Object({
  session_id: Type.String({ description: 'Session ID to read messages from.' }),
  limit: Type.Optional(Type.Number({ description: 'Maximum number of messages to return (default 50).' })),
  offset: Type.Optional(Type.Number({ description: 'Number of messages to skip from the end (0 = most recent). Use with limit to page backwards through history.' })),
});

type SessionReadArgs = Static<typeof SessionReadParams>;

const SessionSummaryParams = Type.Object({
  session_id: Type.String({ description: 'Session ID to summarize.' }),
});

type SessionSummaryArgs = Static<typeof SessionSummaryParams>;

// ── Tools ───────────────────────────────────────────────────────────

export const createSessionListTool = (context: ToolContext): PolicyAwareTool<typeof SessionListParams> => ({
  policy: { defaultGrants: [{ type: 'any' }] },
  name: 'session_list',
  label: 'List Sessions',
  description:
    'List sessions, most-recently-active first. Each entry shows who the session is with '
    + '(`participants` = linked OpenHermit users with names/identities; `counterpart` = the '
    + 'channel-side identity), `type` (direct/group), source, activity, and `canSend` (whether '
    + 'session_send can deliver — do not attempt session_send when false). '
    + 'Filter by `channel`, `type`, `user_id`, or `search`; page with `limit`/`offset` '
    + '(details carry `total` and `hasMore`).',
  parameters: SessionListParams,
  execute: async (_toolCallId, args: SessionListArgs) => {
    if (!context.sessionStore || !context.storeScope) {
      throw new ValidationError('session_list is unavailable: no session store is configured.');
    }

    // Owner sees every session on the agent (so it can answer questions like
    // "who else has chatted with you?"). Non-owners only see sessions they
    // participate in.
    const isOwner = context.currentUserRole === 'owner';
    let sessions = await context.sessionStore.list(
      context.storeScope,
      {
        ...(!isOwner && context.currentUserId ? { userId: context.currentUserId } : {}),
        ...(args.include_inactive ? { includeInactive: true } : {}),
      },
    );

    // ── Filters ──────────────────────────────────────────────────────
    if (args.channel) {
      const ch = args.channel.trim().toLowerCase();
      sessions = sessions.filter(
        (s) => s.source.platform?.toLowerCase() === ch || s.source.kind?.toLowerCase() === ch,
      );
    }
    if (args.type) {
      const t = args.type.trim().toLowerCase();
      sessions = sessions.filter((s) => (s.type ?? s.source.type)?.toLowerCase() === t);
    }
    if (args.user_id) {
      const uid = args.user_id.trim();
      sessions = sessions.filter((s) => s.userIds?.includes(uid));
    }
    if (args.search) {
      const q = args.search.trim().toLowerCase();
      sessions = sessions.filter((s) =>
        [
          s.sessionId,
          s.description,
          s.lastMessagePreview,
          describeCounterpart(s.source.platform, s.metadata),
        ]
          .filter((v): v is string => typeof v === 'string')
          .some((v) => v.toLowerCase().includes(q)),
      );
    }

    // Most recent activity first, then paginate.
    sessions.sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
    const total = sessions.length;
    const limit = Math.min(Math.max(args.limit ?? 20, 1), 100);
    const offset = Math.max(args.offset ?? 0, 0);
    const page = sessions.slice(offset, offset + limit);

    // Batch-resolve participant names + identities for the page's users only.
    const uids = [...new Set(page.flatMap((s) => s.userIds ?? []))];
    const nameById = new Map<string, string>();
    let identsById = new Map<string, { channel: string; channelUserId: string }[]>();
    if (uids.length > 0 && context.userStore) {
      const [records, idents] = await Promise.all([
        Promise.all(uids.map((id) => context.userStore!.get(id))),
        context.userStore.listIdentitiesByUserIds(uids),
      ]);
      records.forEach((r, i) => {
        if (r?.name) nameById.set(uids[i]!, r.name);
      });
      identsById = idents;
    }

    const result = page.map((s) => ({
      sessionId: s.sessionId,
      type: s.type ?? s.source.type ?? (s.source.platform ? 'direct' : undefined),
      description: s.description ?? '(no description)',
      source: s.source,
      participants: (s.userIds ?? []).map((id) => ({
        userId: id,
        ...(nameById.has(id) ? { name: nameById.get(id) } : {}),
        identities: (identsById.get(id) ?? []).map((idn) => `${idn.channel}:${idn.channelUserId}`),
      })),
      counterpart: describeCounterpart(s.source.platform, s.metadata),
      messageCount: s.messageCount,
      lastActivity: s.lastActivityAt,
      createdAt: s.createdAt,
      lastMessagePreview: s.lastMessagePreview,
      // Whether session_send can deliver (channel exposes an outbound adapter
      // AND a recipient resolves from metadata).
      canSend: context.channelOutbound
        ? resolveOutbound(s, context.channelOutbound) !== undefined
        : false,
    }));

    return {
      content: asTextContent(
        result.length > 0 ? formatJson(result) : 'No sessions found.\n',
      ),
      details: { count: result.length, total, offset, limit, hasMore: offset + result.length < total },
    };
  },
});

export const createSessionReadTool = (context: ToolContext): PolicyAwareTool<typeof SessionReadParams> => ({
  policy: { defaultGrants: [{ type: 'any' }] },
  name: 'session_read',
  label: 'Read Session Messages',
  description: 'Read message history from a specified session. Returns recent user and assistant messages. Use this to review what happened in another session.',
  parameters: SessionReadParams,
  execute: async (_toolCallId, args: SessionReadArgs) => {
    if (!context.messageStore || !context.storeScope) {
      throw new ValidationError('session_read is unavailable: no message store is configured.');
    }

    const sessionId = args.session_id.trim();
    if (!sessionId) {
      throw new ValidationError('session_read requires a non-empty session_id.');
    }

    // Owner can read any session on the agent; non-owners must be a
    // participant in user_ids.
    if (
      context.currentUserRole !== 'owner'
      && context.currentUserId
      && context.sessionStore
    ) {
      const target = await context.sessionStore.get(context.storeScope!, sessionId);
      if (!target?.userIds?.includes(context.currentUserId)) {
        throw new ValidationError(`Access denied: you are not a participant in session ${sessionId}.`);
      }
    }

    const limit = args.limit ?? 50;
    const offset = args.offset ?? 0;
    const messages = await context.messageStore.listRecentMessages(context.storeScope, sessionId, limit, offset);

    if (messages.length === 0) {
      return {
        content: asTextContent(`No messages found in session ${sessionId}${offset > 0 ? ` (offset ${offset})` : ''}.\n`),
        details: { sessionId, count: 0, offset },
      };
    }

    const formatted = messages.map((m) => {
      const tag = m.role === 'user' ? '[USER]' : m.role === 'assistant' ? '[ASSISTANT]' : `[${m.role.toUpperCase()}]`;
      const preview = m.content.length > 500 ? `${m.content.slice(0, 500)}…` : m.content;
      return `${m.ts} ${tag} ${preview}`;
    }).join('\n\n');

    return {
      content: asTextContent(`Session ${sessionId} — ${messages.length} messages${offset > 0 ? ` (offset ${offset})` : ''}:\n\n${formatted}\n`),
      details: { sessionId, count: messages.length, offset },
    };
  },
});

export const createSessionSummaryTool = (context: ToolContext): PolicyAwareTool<typeof SessionSummaryParams> => ({
  policy: { defaultGrants: [{ type: 'any' }] },
  name: 'session_summary',
  label: 'Session Summary',
  description: 'Get a summary of a session: description, working memory, message count, and recent activity. Useful for quickly understanding what happened in a session.',
  parameters: SessionSummaryParams,
  execute: async (_toolCallId, args: SessionSummaryArgs) => {
    if (!context.sessionStore || !context.messageStore || !context.storeScope) {
      throw new ValidationError('session_summary is unavailable: stores are not configured.');
    }

    const sessionId = args.session_id.trim();
    if (!sessionId) {
      throw new ValidationError('session_summary requires a non-empty session_id.');
    }

    const session = await context.sessionStore.get(context.storeScope, sessionId);
    if (!session) {
      throw new ValidationError(`Session not found: ${sessionId}`);
    }

    if (context.currentUserId && !session.userIds?.includes(context.currentUserId)) {
      throw new ValidationError(`Access denied: you are not a participant in session ${sessionId}.`);
    }

    const workingMemory = await context.messageStore.getSessionWorkingMemory(context.storeScope, sessionId);
    const compactionSummary = await context.messageStore.getCompactionSummary(context.storeScope, sessionId);
    const recentMessages = await context.messageStore.listRecentMessages(context.storeScope, sessionId, 5);

    const parts: string[] = [];

    parts.push(`**Session:** ${sessionId}`);
    parts.push(`**Description:** ${session.description ?? '(none)'}`);
    parts.push(`**Source:** ${session.source.platform ?? session.source.kind}${session.source.interactive ? ' (interactive)' : ''}`);
    parts.push(`**Messages:** ${session.messageCount}`);
    parts.push(`**Created:** ${session.createdAt}`);
    parts.push(`**Last activity:** ${session.lastActivityAt}`);

    if (workingMemory) {
      parts.push(`\n**Working memory:**\n${workingMemory}`);
    }

    if (compactionSummary) {
      parts.push(`\n**Conversation summary:**\n${compactionSummary}`);
    }

    if (recentMessages.length > 0) {
      const recent = recentMessages.map((m) => {
        const tag = m.role === 'user' ? '[USER]' : m.role === 'assistant' ? '[ASSISTANT]' : `[${m.role.toUpperCase()}]`;
        const preview = m.content.length > 200 ? `${m.content.slice(0, 200)}…` : m.content;
        return `  ${tag} ${preview}`;
      }).join('\n');
      parts.push(`\n**Recent messages:**\n${recent}`);
    }

    return {
      content: asTextContent(`${parts.join('\n')}\n`),
      details: {
        sessionId,
        description: session.description,
        messageCount: session.messageCount,
        hasWorkingMemory: Boolean(workingMemory),
        hasCompactionSummary: Boolean(compactionSummary),
      },
    };
  },
});

// ── session_send ───────────────────────────────────────────────────

const SessionSendParams = Type.Object({
  session_id: Type.String({ description: 'Target session ID to send the message to.' }),
  text: Type.String({ description: 'Message text to send.' }),
});

type SessionSendArgs = Static<typeof SessionSendParams>;

/**
 * Resolve the outbound channel adapter and recipient for a session.
 * Returns undefined if the session has no outbound-capable channel.
 */
export const resolveOutbound = (
  session: { source: { platform?: string }; metadata?: Record<string, unknown> },
  channelOutbound: Map<string, ChannelOutbound>,
): { adapter: ChannelOutbound; to: string } | undefined => {
  const platform = session.source.platform;
  if (!platform) return undefined;

  const adapter = channelOutbound.get(platform);
  if (!adapter) return undefined;

  // Prefer the channel's own recipient resolution — each channel knows its
  // metadata convention (and this works for custom/external channels too).
  const resolved = adapter.resolveRecipient?.(session);
  if (resolved != null && resolved !== '') return { adapter, to: resolved };

  // Back-compat fallback for adapters that predate resolveRecipient.
  if (platform === 'telegram') {
    const chatId = session.metadata?.telegram_chat_id;
    if (chatId !== undefined) return { adapter, to: String(chatId) };
  }

  return undefined;
};

export const createSessionSendTool = (context: ToolContext): PolicyAwareTool<typeof SessionSendParams> => ({
  policy: { defaultGrants: [{ type: 'role', value: 'owner' }, { type: 'role', value: 'user' }] },
  name: 'session_send',
  label: 'Send Message to Session',
  description:
    'Send a message to another session via its connected channel (e.g. Telegram). '
    + 'The target session must have been created through a channel that supports outbound messaging. '
    + 'Use session_list to find sessions and their channel information first.',
  parameters: SessionSendParams,
  execute: async (_toolCallId, args: SessionSendArgs) => {
    if (!context.sessionStore || !context.storeScope) {
      throw new ValidationError('session_send is unavailable: no session store is configured.');
    }
    if (!context.channelOutbound || context.channelOutbound.size === 0) {
      throw new ValidationError('session_send is unavailable: no outbound channels are configured.');
    }
    if (!context.messageStore) {
      throw new ValidationError('session_send is unavailable: no message store is configured.');
    }

    const sessionId = args.session_id.trim();
    if (!sessionId) {
      throw new ValidationError('session_send requires a non-empty session_id.');
    }

    const text = args.text.trim();
    if (!text) {
      throw new ValidationError('session_send requires non-empty text.');
    }

    // Load target session.
    const target = await context.sessionStore.get(context.storeScope, sessionId);
    if (!target) {
      throw new ValidationError(`Session not found: ${sessionId}`);
    }

    // Resolve channel adapter and recipient.
    const outbound = resolveOutbound(target, context.channelOutbound);
    if (!outbound) {
      const platform = target.source.platform ?? target.source.kind;
      throw new ValidationError(
        `Session ${sessionId} (${platform}) does not support outbound messaging, `
        + 'or the channel adapter is not running.',
      );
    }

    // Send the message via the channel adapter.
    const result = await outbound.adapter.send({ sessionId, to: outbound.to, text });

    if (!result.success) {
      return {
        content: asTextContent(`Failed to send message: ${result.error ?? 'unknown error'}\n`),
        details: { sessionId, success: false, error: result.error },
      };
    }

    // Record the delivery as a normal assistant message in the target session.
    // Delivery details (source channel, recipient, originating session) live in
    // metadata so they don't pollute the conversation body.
    await context.messageStore.appendLogEntry(context.storeScope, sessionId, {
      ts: new Date().toISOString(),
      role: 'assistant',
      content: text,
      metadata: {
        source: 'session_send',
        ...(context.sessionId ? { fromSession: context.sessionId } : {}),
        channel: outbound.adapter.channel,
        to: outbound.to,
        ...(result.messageId ? { messageId: result.messageId } : {}),
      },
    });

    return {
      content: asTextContent(
        `Message sent to session ${sessionId} via ${outbound.adapter.channel}`
        + (result.messageId ? ` (message ID: ${result.messageId})` : '')
        + '.\n',
      ),
      details: { sessionId, channel: outbound.adapter.channel, success: true, messageId: result.messageId },
    };
  },
});

// ── Toolset ────────────────────────────────────────────────────────

const SESSION_DESCRIPTION = `\
### Session Management

You can inspect sessions across all channels. Non-owner users can only see sessions they participated in.

These tools let you review what happened in other sessions without switching context. For example:
- "show me recent sessions" → \`session_list\`
- "what happened in that Telegram chat?" → \`session_list\` (filter by telegram) → \`session_summary\`
- "read me the last messages from session X" → \`session_read\`
- "send a message to user X on Telegram" → \`session_list\` (find their session) → \`session_send\``;

export const createSessionToolset = (context: ToolContext): Toolset => {
  const tools: PolicyAwareTool[] = [
    createSessionListTool(context),
    createSessionReadTool(context),
    createSessionSummaryTool(context),
  ];

  // Only include session_send when outbound channels are available.
  if (context.channelOutbound && context.channelOutbound.size > 0) {
    tools.push(createSessionSendTool(context));
  }

  return {
    id: 'session',
    description: SESSION_DESCRIPTION,
    tools,
  };
};
