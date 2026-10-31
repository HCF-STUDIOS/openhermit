import type { AgentMessage } from '@mariozechner/pi-agent-core';
import type { AssistantMessage } from '@mariozechner/pi-ai';

import { applyRollingWindow } from './context-compaction.js';
import { isAssistantMessage } from './message-utils.js';

/**
 * Context-overflow recovery.
 *
 * Even with model-window-aware compaction (`getContextCompactionMaxTokens`), a
 * turn can still be rejected with a context-length error: token estimation is
 * approximate (`chars/4`, drifting on CJK and tool JSON), a single recent tool
 * result or attachment can be huge, and some providers enforce a real limit
 * below their advertised `contextWindow`. When that happens the user today just
 * sees "this conversation is too long."
 *
 * Instead we retry once: deterministically shrink the live transcript and
 * re-generate via `agent.continue()`. The shrink is a plain rolling-window cut
 * (tool-pair safe) — NOT a second summary LLM call, which could itself overflow
 * or fail. The retry budget is per-turn and small; once spent, the error
 * surfaces through the normal path, so an ineffective shrink can never fail
 * silently — at worst it costs one extra generation before the real error shows.
 *
 * Modeled on DeepSeek Harness's compaction/context-overflow handling, adapted to
 * our hot-path turn driver. openhermit-only; the user-visible "整理记忆中…" signal
 * is a separate cross-repo follow-up (protocol + channels + amiko).
 */

export const CONTEXT_OVERFLOW_MAX_RETRIES_ENV = 'OPENHERMIT_CONTEXT_OVERFLOW_MAX_RETRIES';

/** One retry clears the overwhelming majority of estimation-drift overflows
 *  without turning a hard overflow into a long stall. */
export const DEFAULT_CONTEXT_OVERFLOW_MAX_RETRIES = 1;

/** Floor on the messages kept by a shrink, so the retry still has enough recent
 *  context to produce a coherent reply (tool pairs may pull this slightly up). */
export const CONTEXT_OVERFLOW_MIN_RETAINED_MESSAGES = 8;

export const resolveContextOverflowMaxRetries = (
  env: NodeJS.ProcessEnv = process.env,
): number => {
  const raw = env[CONTEXT_OVERFLOW_MAX_RETRIES_ENV];
  if (raw === undefined || raw.trim() === '') {
    return DEFAULT_CONTEXT_OVERFLOW_MAX_RETRIES;
  }
  const parsed = Number(raw);
  // 0 (or negative) disables recovery; NaN falls back to the default.
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_CONTEXT_OVERFLOW_MAX_RETRIES;
};

/** A failed/interrupted generation placeholder left at the tail of the live
 *  transcript — must be removed before `agent.continue()`, whose precondition is
 *  that the last message is a user or tool-result message. */
const isFailedTrailingAssistant = (m: AgentMessage): boolean =>
  isAssistantMessage(m) &&
  ((m as AssistantMessage).stopReason === 'error' || (m as AssistantMessage).stopReason === 'aborted');

/**
 * Deterministically shrink a live transcript for a context-overflow retry.
 *
 * 1. Drop the trailing failed-generation assistant placeholder(s).
 * 2. Aggressively roll the window back to roughly half its length (floored at
 *    {@link CONTEXT_OVERFLOW_MIN_RETAINED_MESSAGES}), keeping tool pairs intact.
 * 3. Drop any trailing assistant message so the result ends on a user/tool-result
 *    message, satisfying `agent.continue()`'s precondition.
 *
 * Always returns a FRESH array (never the input reference), so the caller can
 * safely clear and refill the live `state.messages` array in place.
 */
export const shrinkMessagesForRetry = (
  messages: AgentMessage[],
  options: { minRetained?: number } = {},
): AgentMessage[] => {
  const minRetained = options.minRetained ?? CONTEXT_OVERFLOW_MIN_RETAINED_MESSAGES;

  // 1. Drop trailing failed-generation placeholder(s).
  let end = messages.length;
  while (end > 0 && isFailedTrailingAssistant(messages[end - 1]!)) {
    end -= 1;
  }
  const withoutPlaceholder = messages.slice(0, end);

  // 2. Aggressive rolling window — halve, floored at minRetained.
  const target = Math.max(minRetained, Math.floor(withoutPlaceholder.length / 2));
  const windowed = applyRollingWindow(withoutPlaceholder, target);

  // 3. Ensure the tail is a user/tool-result message for continue().
  let lastIndex = windowed.length - 1;
  while (lastIndex >= 0 && (windowed[lastIndex] as AssistantMessage).role === 'assistant') {
    lastIndex -= 1;
  }
  const trimmed = lastIndex < windowed.length - 1 ? windowed.slice(0, lastIndex + 1) : windowed;

  // Guarantee a fresh array even when every step above was a no-op.
  return trimmed === messages ? messages.slice() : trimmed.slice();
};
