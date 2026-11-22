import { Type, type Static } from 'typebox';
import { ValidationError } from '@openhermit/shared';

import {
  type PolicyAwareTool,
  type Toolset,
  type ToolContext,
  asTextContent,
  formatJson,
} from './shared.js';
import { type Grant, type Principal, buildPrincipal, canAccess } from '../core/policy.js';
import type { MemoryEntry } from '@openhermit/store';

const principalFrom = (ctx: ToolContext): Principal | undefined =>
  ctx.agentId
    ? buildPrincipal(ctx.agentId, ctx.currentUserId, ctx.currentUserRole)
    : undefined;

const memoryVisible = (entry: MemoryEntry, principal: Principal | undefined): boolean => {
  const grants = entry.grants;
  if (!Array.isArray(grants) || grants.length === 0) return true;
  if (!principal) return false;
  if (principal.role === 'owner') return true;
  return canAccess(principal, grants as Grant[]);
};

const MemoryRecallParams = Type.Object({
  query: Type.String({
    description: 'Keyword or phrase to search in memory.',
  }),
  limit: Type.Optional(
    Type.Number({
      description: 'Maximum number of matches to return. Defaults to 5.',
    }),
  ),
});

type MemoryRecallArgs = Static<typeof MemoryRecallParams>;

const MemoryGetParams = Type.Object({
  key: Type.String({
    description:
      'Exact memory key to read.',
  }),
});

type MemoryGetArgs = Static<typeof MemoryGetParams>;

const MemoryUpdateParams = Type.Object({
  key: Type.String({
    description: 'Key of the memory entry to update.',
  }),
  content: Type.Optional(
    Type.String({
      description: 'New content for the memory entry.',
    }),
  ),
  metadata: Type.Optional(
    Type.Record(Type.String(), Type.Unknown(), {
      description: 'Metadata to merge into the existing entry.',
    }),
  ),
});

type MemoryUpdateArgs = Static<typeof MemoryUpdateParams>;

const GrantSchema = Type.Object({
  type: Type.String({ description: '"any", "role", or "user".' }),
  value: Type.Optional(Type.String({ description: 'Role name or user ID.' })),
});

const MemoryAddParams = Type.Object({
  key: Type.Optional(
    Type.String({
      description:
        'Stable memory key following the namespacing rules in the Memory section (e.g. "agent/name", "user/{userId}/preferences", "project/conventions"). If omitted, one is generated automatically.',
    }),
  ),
  content: Type.String({
    description: 'The memory content to store.',
  }),
  metadata: Type.Optional(
    Type.Record(Type.String(), Type.Unknown(), {
      description: 'Optional metadata (e.g. title, tags) to help future retrieval.',
    }),
  ),
  grants: Type.Optional(
    Type.Array(GrantSchema, {
      description: 'Access grants. Empty array or omitted = open to everyone. Example: [{"type":"role","value":"owner"}] restricts to owner only.',
    }),
  ),
});

type MemoryAddArgs = Static<typeof MemoryAddParams>;

const MemoryDeleteParams = Type.Object({
  key: Type.String({
    description: 'Key of the memory entry to delete.',
  }),
});

type MemoryDeleteArgs = Static<typeof MemoryDeleteParams>;

export const createMemoryGetTool = (ctx: ToolContext): PolicyAwareTool<typeof MemoryGetParams> => ({
  policy: { defaultGrants: [{ type: 'any' }] },
  name: 'memory_get',
  label: 'Get Memory',
  description:
    'Read one memory entry by exact key.',
  parameters: MemoryGetParams,
  execute: async (_toolCallId, args: MemoryGetArgs) => {
    if (!ctx.memoryProvider || !ctx.storeScope) {
      throw new ValidationError('memory_get is unavailable: no memory provider is configured.');
    }

    const key = args.key.trim();
    if (!key) {
      throw new ValidationError('memory_get requires a non-empty key.');
    }

    const entry = await ctx.memoryProvider.get(ctx.storeScope, key);
    if (!entry) {
      throw new ValidationError(`Memory not found: ${key}`);
    }

    if (!memoryVisible(entry, principalFrom(ctx))) {
      throw new ValidationError(`Memory not found: ${key}`);
    }

    return {
      content: asTextContent(formatJson(entry)),
      details: entry,
    };
  },
});

const MemoryListParams = Type.Object({
  prefix: Type.String({
    description: 'Key prefix to list entries under (e.g. "user/usr-owner", "project", "agent"). Use empty string to list all.',
  }),
  limit: Type.Optional(
    Type.Number({
      description: 'Maximum number of entries to return. Defaults to 20.',
    }),
  ),
});

type MemoryListArgs = Static<typeof MemoryListParams>;

export const createMemoryListTool = (ctx: ToolContext): PolicyAwareTool<typeof MemoryListParams> => ({
  policy: { defaultGrants: [{ type: 'any' }] },
  name: 'memory_list',
  label: 'List Memory',
  description:
    'List memory entries by key prefix. Returns keys with a content preview for each entry. Use this to browse what memories exist under a namespace (e.g. "user/usr-owner/", "project/", "agent/") before using memory_get or memory_recall for details.',
  parameters: MemoryListParams,
  execute: async (_toolCallId, args: MemoryListArgs) => {
    if (!ctx.memoryProvider || !ctx.storeScope) {
      throw new ValidationError('memory_list is unavailable: no memory provider is configured.');
    }

    const prefix = args.prefix.trim();
    const limit = Math.max(1, Math.min(50, Math.trunc(args.limit ?? 20)));
    const principal = principalFrom(ctx);
    const raw = await ctx.memoryProvider.list(ctx.storeScope, prefix, { limit: 50 });
    const entries = raw.filter(e => memoryVisible(e, principal)).slice(0, limit);

    if (entries.length === 0) {
      return {
        content: asTextContent(`No memory entries found under "${prefix}".\n`),
        details: { prefix, limit, count: 0, entries: [] },
      };
    }

    const summary = entries.map(e => ({
      key: e.id,
      preview: e.content.length > 120 ? `${e.content.slice(0, 120)}...` : e.content,
      updatedAt: e.updatedAt,
    }));

    return {
      content: asTextContent(formatJson(summary)),
      details: { prefix, limit, count: entries.length, entries: summary },
    };
  },
});

export const createMemoryRecallTool = (ctx: ToolContext): PolicyAwareTool<typeof MemoryRecallParams> => ({
  policy: { defaultGrants: [{ type: 'any' }] },
  name: 'memory_recall',
  label: 'Recall Memory',
  description:
    'Search memory entries by keyword or phrase. Supports word-level matching with stemming — multi-word queries match individual tokens, not exact substrings. Use before adding new memories to avoid duplicates.',
  parameters: MemoryRecallParams,
  execute: async (_toolCallId, args: MemoryRecallArgs) => {
    if (!ctx.memoryProvider || !ctx.storeScope) {
      throw new ValidationError('memory_recall is unavailable: no memory provider is configured.');
    }

    const query = args.query.trim();
    if (!query) {
      throw new ValidationError('memory_recall requires a non-empty query.');
    }

    const limit = Math.max(1, Math.min(10, Math.trunc(args.limit ?? 5)));
    const principal = principalFrom(ctx);
    const raw = await ctx.memoryProvider.search(ctx.storeScope, query, { limit: 20 });
    const matches = raw.filter(e => memoryVisible(e, principal)).slice(0, limit);

    const text = matches.length > 0
      ? formatJson(matches)
      : 'No memory entries matched.\n';

    return {
      content: asTextContent(text),
      details: {
        query,
        limit,
        count: matches.length,
        matches,
      },
    };
  },
});

export const createMemoryAddTool = ({
  security,
  memoryProvider,
  storeScope,
  hookBus,
  agentId,
}: ToolContext): PolicyAwareTool<typeof MemoryAddParams> => ({
  policy: { defaultGrants: [{ type: 'role', value: 'owner' }, { type: 'role', value: 'user' }] },
  name: 'memory_add',
  label: 'Add Memory',
  description:
    'Create or upsert a memory entry. Use semantic keys following the namespacing rules (e.g. "agent/name", "user/{userId}/preferences", "project/conventions"), or omit the key for auto-generated ones. Save proactively when the user shares preferences, corrects you, or reveals project decisions. Use memory_recall first to check for existing entries and avoid duplicates.',
  parameters: MemoryAddParams,
  execute: async (_toolCallId, args: MemoryAddArgs) => {
    if (!memoryProvider || !storeScope) {
      throw new ValidationError('memory_add is unavailable: no memory provider is configured.');
    }

    const content = args.content.trim();
    if (!content) {
      throw new ValidationError('memory_add requires non-empty content.');
    }

    const entry = await memoryProvider.add(storeScope, {
      ...(args.key?.trim() ? { id: args.key.trim() } : {}),
      content,
      ...(args.metadata ? { metadata: args.metadata as Record<string, unknown> } : {}),
      ...(args.grants ? { grants: args.grants } : {}),
    });

    if (hookBus && agentId) {
      await hookBus.emit('memory.upsert@v1', {
        agentId,
        key: entry.id,
        content: entry.content ?? content,
        metadata: (entry.metadata ?? args.metadata ?? {}) as Record<string, unknown>,
      });
    }

    return {
      content: asTextContent(formatJson(entry)),
      details: entry,
    };
  },
});

export const createMemoryUpdateTool = ({
  security,
  memoryProvider,
  storeScope,
  hookBus,
  agentId,
}: ToolContext): PolicyAwareTool<typeof MemoryUpdateParams> => ({
  policy: { defaultGrants: [{ type: 'role', value: 'owner' }, { type: 'role', value: 'user' }] },
  name: 'memory_update',
  label: 'Update Memory',
  description:
    'Update an existing memory entry by key. Use memory_get first to read the current content before updating.',
  parameters: MemoryUpdateParams,
  execute: async (_toolCallId, args: MemoryUpdateArgs) => {
    if (!memoryProvider || !storeScope) {
      throw new ValidationError('memory_update is unavailable: no memory provider is configured.');
    }

    const key = args.key.trim();
    if (!key) {
      throw new ValidationError('memory_update requires a non-empty key.');
    }

    const entry = await memoryProvider.update(storeScope, key, {
      ...(args.content?.trim() ? { content: args.content.trim() } : {}),
      ...(args.metadata ? { metadata: args.metadata as Record<string, unknown> } : {}),
    });

    if (hookBus && agentId) {
      await hookBus.emit('memory.upsert@v1', {
        agentId,
        key,
        content: entry.content ?? args.content?.trim() ?? '',
        metadata: (entry.metadata ?? args.metadata ?? {}) as Record<string, unknown>,
      });
    }

    return {
      content: asTextContent(formatJson(entry)),
      details: entry,
    };
  },
});

export const createMemoryDeleteTool = ({
  security,
  memoryProvider,
  storeScope,
}: ToolContext): PolicyAwareTool<typeof MemoryDeleteParams> => ({
  policy: { defaultGrants: [{ type: 'role', value: 'owner' }, { type: 'role', value: 'user' }] },
  name: 'memory_delete',
  label: 'Delete Memory',
  description:
    'Delete a memory entry by key.',
  parameters: MemoryDeleteParams,
  execute: async (_toolCallId, args: MemoryDeleteArgs) => {
    if (!memoryProvider || !storeScope) {
      throw new ValidationError('memory_delete is unavailable: no memory provider is configured.');
    }

    const key = args.key.trim();
    if (!key) {
      throw new ValidationError('memory_delete requires a non-empty key.');
    }

    await memoryProvider.delete(storeScope, key);

    return {
      content: asTextContent(`Deleted memory: ${key}\n`),
      details: { key },
    };
  },
});

const MemorySetGrantsParams = Type.Object({
  key: Type.String({
    description: 'Key of the memory entry to update grants for.',
  }),
  grants: Type.Array(GrantSchema, {
    description: 'New grants array. Empty [] = open to everyone. Example: [{"type":"role","value":"owner"}].',
  }),
});

type MemorySetGrantsArgs = Static<typeof MemorySetGrantsParams>;

export const createMemorySetGrantsTool = ({
  security,
  memoryProvider,
  storeScope,
}: ToolContext): PolicyAwareTool<typeof MemorySetGrantsParams> => ({
  policy: { defaultGrants: [{ type: 'role', value: 'owner' }] },
  name: 'memory_set_grants',
  label: 'Set Memory Grants',
  description:
    'Set access grants on a memory entry. Only the owner can change who can read a memory. Empty grants = open to everyone.',
  parameters: MemorySetGrantsParams,
  execute: async (_toolCallId, args: MemorySetGrantsArgs) => {
    if (!memoryProvider || !storeScope) {
      throw new ValidationError('memory_set_grants is unavailable: no memory provider is configured.');
    }

    const key = args.key.trim();
    if (!key) {
      throw new ValidationError('memory_set_grants requires a non-empty key.');
    }

    const entry = await memoryProvider.update(storeScope, key, {
      grants: args.grants,
    });

    return {
      content: asTextContent(formatJson(entry)),
      details: entry,
    };
  },
});

// ── Toolset ────────────────────────────────────────────────────────

const MEMORY_DESCRIPTION = `\
### Memory

You have persistent memory across sessions. The most valuable memory is one that prevents the user from having to correct or remind you again.

**Priority:** user preferences and corrections > project decisions and constraints > environment facts > procedural knowledge.

**When to save** (do this proactively, don't wait to be asked):
- User corrects you or says "remember this" / "don't do that again"
- User shares a preference, habit, or personal detail
- You discover a project decision, architectural constraint, or convention
- You learn something about the user's environment or workflow

**Do NOT save:** task progress, session outcomes, completed-work logs, content the user browsed, trivially re-discoverable facts, or raw data dumps.

**When to recall:** Use \`memory_list\` to browse what exists under a namespace (e.g. \`user/{userId}/\`, \`project/\`) before searching. Use \`memory_recall\` for keyword search when you know what you're looking for. Memory is not automatically injected; you must search for it when relevant.

**ID namespacing (strict):**
- \`agent/…\` — the agent's own identity and configuration (e.g. \`agent/name\`, \`agent/identity\`)
- \`user/{userId}/…\` — per-user data, MUST include the actual userId (e.g. \`user/usr-abc/preferences\`, \`user/usr-abc/name\`)
- \`project/…\` — project-wide knowledge (e.g. \`project/plan\`, \`project/conventions\`)

**Never** use bare \`user/…\` without a userId — this is a multi-user system, so \`user/name\` is ambiguous. Always use \`user/{userId}/name\` with the specific user's ID from the Current User section.

When recalling user-specific information, search with the user's ID prefix. This keeps per-user data isolated and retrievable.

**Grants (visibility):**
When creating a memory with \`memory_add\`, set the \`grants\` parameter to control who can read it:
- \`user/{userId}/…\` memories → set \`grants: [{type:"user", value:"{userId}"}]\` so only that user (and owner) can see them.
- \`project/…\` and \`agent/…\` memories → omit grants or pass \`[]\` (open to everyone).
- Owner-sensitive information → set \`grants: [{type:"role", value:"owner"}]\`.
Owner always has visibility into all memories regardless of grants.`;

export const createMemoryToolset = (context: ToolContext): Toolset => ({
  id: 'memory',
  description: MEMORY_DESCRIPTION,
  tools: [
    createMemoryGetTool(context),
    createMemoryListTool(context),
    createMemoryRecallTool(context),
    createMemoryAddTool(context),
    createMemoryUpdateTool(context),
    createMemoryDeleteTool(context),
    createMemorySetGrantsTool(context),
  ],
});
