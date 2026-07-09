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
  limit: Type.Optional(Type.Number({ description: 'Maximum number of older messages to return (default 50).' })),
  offset: Type.Optional(Type.Number({ description: 'Number of messages to skip from the end (0 = most recent). Use with limit to page backwards through this conversation.' })),
});

type HistoryFetchArgs = Static<typeof HistoryFetchParams>;

// ── Tool ────────────────────────────────────────────────────────────

export const createHistoryFetchTool = (context: ToolContext): PolicyAwareTool<typeof HistoryFetchParams> => ({
  policy: { defaultGrants: [{ type: 'any' }] },
  name: 'fetch_full_history',
  label: 'Fetch Full History',
  description:
    'Fetch older messages from THIS conversation that may have scrolled out of the live context window. '
    + 'Returns user and assistant messages, most recent first. Page backwards with `limit`/`offset`. '
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
      const tag = m.role === 'user' ? '[USER]' : m.role === 'assistant' ? '[ASSISTANT]' : `[${m.role.toUpperCase()}]`;
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

When a rolling context window is active, only the most recent messages are kept live. Use \`fetch_full_history\` to pull older messages from this conversation on demand — nothing is lost.`;

export const createHistoryToolset = (context: ToolContext): Toolset => ({
  id: 'history',
  description: HISTORY_DESCRIPTION,
  tools: [createHistoryFetchTool(context)],
});
