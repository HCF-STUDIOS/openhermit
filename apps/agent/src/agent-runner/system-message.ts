import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { getCurrentSystemMessage, type SystemMessage } from '@earendil-works/pi-ai';

/**
 * pi-agent-core 1.x carries the system prompt and the tool declarations inside
 * the transcript as `role: "system"` messages (a leading one, plus optional
 * later patches). The rest of the runner — resumption, compaction, the
 * provider wire-shape repairs — reasons about the *conversation* only, so it
 * works on the non-system messages and these helpers keep the system head
 * intact across every in-place rewrite of the live transcript.
 */

export const isSystemMessage = (message: AgentMessage): message is SystemMessage =>
  (message as { role?: unknown }).role === 'system';

export const splitSystemMessages = (
  messages: readonly AgentMessage[],
): { system: SystemMessage[]; conversation: AgentMessage[] } => {
  const system: SystemMessage[] = [];
  const conversation: AgentMessage[] = [];
  for (const message of messages) {
    if (isSystemMessage(message)) system.push(message);
    else conversation.push(message);
  }
  return { system, conversation };
};

/**
 * Replace the conversation part of a live transcript in place, keeping its
 * system messages at the head. In place because pi-agent-core's in-flight
 * loop appends to the same array reference.
 */
export const replaceConversation = (live: AgentMessage[], conversation: readonly AgentMessage[]): void => {
  const { system } = splitSystemMessages(live);
  live.length = 0;
  live.push(...system, ...conversation.filter((m) => !isSystemMessage(m)));
};

/**
 * Swap the system head of `live` for the replayed system message of `source`
 * (prompt + tool declarations), collapsing any mid-transcript system patches.
 * Used when the runner rebuilds the prompt/tools for a new turn: the fresh
 * head declares exactly the agent's current tools, so pi-agent-core sees no
 * tool diff and inserts no update message.
 */
export const replaceSystemHead = (live: AgentMessage[], source: readonly AgentMessage[]): void => {
  const head = getCurrentSystemMessage(source);
  const { conversation } = splitSystemMessages(live);
  live.length = 0;
  if (head) live.push(head);
  live.push(...conversation);
};
