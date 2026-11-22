import { Type, type Static } from 'typebox';

import { type PolicyAwareTool, type ToolContext, asTextContent } from './shared.js';

const SessionDescriptionUpdateParams = Type.Object({
  description: Type.String({
    description:
      'A short session title for retrieval (under 10 words). '
      + 'Plain text only — no quotes, markdown, or trailing punctuation.',
  }),
});

type SessionDescriptionUpdateArgs = Static<typeof SessionDescriptionUpdateParams>;

export const createSessionDescriptionUpdateTool = (
  context: ToolContext,
): PolicyAwareTool<typeof SessionDescriptionUpdateParams> => ({
  policy: { defaultGrants: [] },
  name: 'session_description_update',
  label: 'Session Description Update',
  description:
    'Update the session description (title). '
    + 'This is shown in session lists and helps the user find past conversations. '
    + 'Keep it short, specific, and descriptive of what the session is about.',
  parameters: SessionDescriptionUpdateParams,
  execute: async (_toolCallId, args: SessionDescriptionUpdateArgs) => {
    const { sessionStore, storeScope, sessionId } = context;

    if (!sessionStore || !storeScope || !sessionId) {
      return {
        content: asTextContent('Session description update is not available in this context.'),
        details: {},
      };
    }

    const normalized = args.description
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^["'`]+|["'`]+$/g, '')
      .replace(/^[#*\-\s]+/, '');

    if (!normalized) {
      return {
        content: asTextContent('Description is empty after normalization.'),
        details: {},
      };
    }

    const description = normalized.length <= 80
      ? normalized
      : `${normalized.slice(0, 77)}...`;

    await sessionStore.updateDescription(storeScope, sessionId, description, 'ai');

    return {
      content: asTextContent(`Session description updated: ${description}`),
      details: { description },
    };
  },
});
