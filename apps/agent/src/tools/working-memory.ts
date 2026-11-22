import { Type, type Static } from 'typebox';

import { type PolicyAwareTool, type ToolContext, asTextContent } from './shared.js';

const WorkingMemoryUpdateParams = Type.Object({
  content: Type.String({
    description:
      'The full content to write to your session working memory (scratchpad). '
      + 'This replaces the previous content entirely. Use concise markdown. '
      + 'Record key facts, decisions, file paths, and context you will need in later turns.',
  }),
});

type WorkingMemoryUpdateArgs = Static<typeof WorkingMemoryUpdateParams>;

export const createWorkingMemoryUpdateTool = (
  context: ToolContext,
): PolicyAwareTool<typeof WorkingMemoryUpdateParams> => ({
  policy: { defaultGrants: [] },
  name: 'working_memory_update',
  label: 'Working Memory Update',
  description:
    'Update your session-local working memory (scratchpad). '
    + 'This is injected into your context on every turn so you can persist notes, '
    + 'intermediate results, or reminders across the conversation. '
    + 'The content you write here replaces the previous content entirely.',
  parameters: WorkingMemoryUpdateParams,
  execute: async (_toolCallId, args: WorkingMemoryUpdateArgs) => {
    const { messageStore, storeScope, sessionId } = context;

    if (!messageStore || !storeScope || !sessionId) {
      return {
        content: asTextContent('Working memory is not available in this context.'),
        details: {},
      };
    }

    const ts = new Date().toISOString();
    await messageStore.setSessionWorkingMemory(storeScope, sessionId, args.content, ts);

    return {
      content: asTextContent('Working memory updated.'),
      details: { length: args.content.length },
    };
  },
});
