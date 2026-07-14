/**
 * Whether an `agent_end` frame closes the turn a bridge reader opened for
 * `ownMessageId`. Mirrors the gateway's `agentEndClosesStream`: a bridge that
 * posts message B behind an already-running turn A must ignore A's session-wide
 * `agent_end` and close only on the end that answered B — otherwise two
 * overlapping messages in the same chat cross wires (B returns A's reply and B's
 * own reply is lost). `answeredMessageIds` is the authoritative set (the trigger
 * plus every message folded into the turn); it falls back to the single
 * `messageId`, then to closing on any end.
 *
 * Backward-compatible: when the reader has no id of its own (`ownMessageId`
 * undefined) or the runner emits an end with neither field, close on any end so
 * an older peer never hangs.
 */
export const agentEndClosesTurn = (
  agentEndPayload: Record<string, unknown>,
  ownMessageId: string | undefined,
): boolean => {
  if (ownMessageId === undefined) return true;
  const answered = agentEndPayload.answeredMessageIds;
  if (Array.isArray(answered)) return answered.includes(ownMessageId);
  const messageId = agentEndPayload.messageId;
  return messageId === undefined || messageId === ownMessageId;
};
