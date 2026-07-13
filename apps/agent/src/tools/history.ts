import { Type, type Static } from '@mariozechner/pi-ai';
import { ValidationError } from '@openhermit/shared';

import {
  type PolicyAwareTool,
  type Toolset,
  type ToolContext,
  asTextContent,
} from './shared.js';

// ── Parameters ──────────────────────────────────────────────────────

const HistoryFetchParams = Type.Object({
  limit: Type.Optional(Type.Number({ description: 'Maximum number of messages to return (default 50).' })),
  offset: Type.Optional(Type.Number({
    description:
      'Number of messages to skip from the end before returning (same pagination model as session_read). '
      + 'Default 0 returns the most recent messages, which usually already sit in the live window. '
      + 'To reach turns that scrolled out of the rolling window, set offset ≈ rolling_window_messages '
      + '(default 40 when that config is set), then page further back by increasing offset.',
  })),
});

type HistoryFetchArgs = Static<typeof HistoryFetchParams>;

// ── Tool ────────────────────────────────────────────────────────────

export const createHistoryFetchTool = (context: ToolContext): PolicyAwareTool<typeof HistoryFetchParams> => ({
  policy: { defaultGrants: [{ type: 'any' }] },
  name: 'fetch_full_history',
  label: 'Fetch Full History',
  description:
    'Fetch messages from THIS conversation via the store (same offset/limit model as session_read). '
    + 'Returns user and assistant messages, most recent first. '
    + 'offset 0 (default) returns the most recent messages, which are usually already in the live context. '
    + 'To fetch older messages that scrolled out of a rolling window, set offset ≈ rolling_window_messages '
    + '(default 40) and page further with higher offsets. '
    + 'Use this when you need context from earlier in the conversation that is no longer visible.',
  parameters: HistoryFetchParams,
  execute: async (_toolCallId, args: HistoryFetchArgs) => {
    if (!context.messageStore || !context.storeScope || !context.sessionId) {
      throw new ValidationError('fetch_full_history is unavailable: no message store or session is configured.');
    }

    const sessionId = context.sessionId;
    const limit = args.limit ?? 50;
    const offset = args.offset ?? 0;
    const messages = await context.messageStore.listRecentMessages(context.storeScope, sessionId, limit, offset);

    if (messages.length === 0) {
      return {
        content: asTextContent(`No older messages found${offset > 0 ? ` (offset ${offset})` : ''}.\n`),
        details: { sessionId, count: 0, offset },
      };
    }

    const formatted = messages.map((m) => {
      const tag = `[${m.role.toUpperCase()}]`;
      const preview = m.content.length > 500 ? `${m.content.slice(0, 500)}…` : m.content;
      return `${m.ts} ${tag} ${preview}`;
    }).join('\n\n');

    return {
      content: asTextContent(`${messages.length} older messages${offset > 0 ? ` (offset ${offset})` : ''}:\n\n${formatted}\n`),
      details: { sessionId, count: messages.length, offset },
    };
  },
});

// ── Toolset ────────────────────────────────────────────────────────

const HISTORY_DESCRIPTION = `\
### Conversation History

When a rolling context window is active, only the most recent messages are kept live. Use \`fetch_full_history\` to pull older messages from this conversation on demand — nothing is lost. Default offset 0 returns the most recent store tail (often already in context); set offset ≈ \`rolling_window_messages\` (default 40) to reach scrolled-out turns.`;

export const createHistoryToolset = (context: ToolContext): Toolset => ({
  id: 'history',
  description: HISTORY_DESCRIPTION,
  tools: [createHistoryFetchTool(context)],
});
