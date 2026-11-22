import type { AgentMessage } from '@earendil-works/pi-agent-core';

/**
 * Per-turn facts that change between turns (wall-clock time, and in group
 * sessions who sent the latest message).
 *
 * They deliberately do NOT live in the system prompt: the system prompt sits
 * in front of the whole conversation, so any byte that changes there
 * invalidates the provider's prompt cache for the entire history on every
 * turn. Instead they ride on the latest user message as a short note, attached
 * at request time only (never persisted). The note is snapshotted once at turn
 * start, so every LLM call inside the turn's tool loop sends identical bytes;
 * on the next turn only the previous user message loses its note, so the cache
 * still covers everything before the last turn.
 */
export interface TurnContext {
  at: Date;
  sender?: {
    userId: string;
    name?: string | undefined;
    role?: string | undefined;
  } | undefined;
}

export const formatTurnContextNote = (context: TurnContext): string => {
  const at = context.at;
  const stamp = at.toISOString().slice(0, 16).replace('T', ' ');
  const weekday = at.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
  const parts = [`Current time: ${stamp} UTC (${weekday}).`];
  if (context.sender) {
    const name = context.sender.name ? ` (${context.sender.name})` : '';
    const role = context.sender.role ? `, role: ${context.sender.role}` : '';
    parts.push(`Sender: \`${context.sender.userId}\`${name}${role}.`);
  }
  return `[Turn context, added by the runtime, not written by the user] ${parts.join(' ')}`;
};

/**
 * Return a copy of `messages` with `note` appended to the LAST user message.
 * The input array and its messages are never mutated, so the note cannot leak
 * into live agent state or stored history.
 */
export const attachTurnContextNote = (
  messages: AgentMessage[],
  note: string,
): AgentMessage[] => {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]!;
    if (message.role !== 'user') continue;
    const content = message.content;
    const annotated: AgentMessage = typeof content === 'string'
      ? { ...message, content: `${content}\n\n${note}` }
      : { ...message, content: [...content, { type: 'text', text: note }] };
    const copy = messages.slice();
    copy[i] = annotated;
    return copy;
  }
  return messages;
};
