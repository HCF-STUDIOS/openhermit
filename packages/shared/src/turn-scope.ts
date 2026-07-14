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

/**
 * Whether a per-turn content frame (`text_delta`/`text_final`/`tool_result`)
 * belongs to the turn a bridge reader opened for `ownMessageId`. Mirrors the
 * gateway's `streamEventInScope` and the reader's own `agentEndClosesTurn`
 * close scoping: a bridge with no per-chat serialization (readers can overlap
 * on one session) must not accumulate a concurrent turn's text, or it posts the
 * wrong reply. Content frames carry the turn's trigger as `correlationId`.
 *
 * Backward-compatible: a reader with no id of its own (`ownMessageId`
 * undefined), or a frame from an older runner that carries no `correlationId`,
 * is accepted so no peer regresses.
 */
export const turnContentInScope = (
  payload: Record<string, unknown>,
  ownMessageId: string | undefined,
): boolean => {
  if (ownMessageId === undefined) return true;
  const correlationId = payload.correlationId;
  return correlationId === undefined || correlationId === ownMessageId;
};

/**
 * Whether a decoded `error` frame is out-of-band (a media-job failure or an
 * internal reconcile-cancel) rather than a turn failure. Mirrors the protocol's
 * `isOutOfBandError` but operates on a raw frame record. The invariant is the
 * `reason` field, never the presence of `correlationId`: a turn error carries
 * the turn trigger as `correlationId` and no `reason`, so classifying by
 * `correlationId` would misread it as media. Out-of-band errors are delivered
 * session-wide by the persistent subscription; a turn error stays with its own
 * in-turn reader.
 */
export const isOutOfBandErrorFrame = (
  payload: Record<string, unknown>,
): boolean =>
  payload.reason === 'reconcile_cancel' || payload.reason === 'media_error';
