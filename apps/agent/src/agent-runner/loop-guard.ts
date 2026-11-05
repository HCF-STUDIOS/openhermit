import type { ImageContent, TextContent } from '@mariozechner/pi-ai';

/**
 * Content-based loop guard.
 *
 * Our existing turn guards are time- and failure-shaped: a 10-minute inactivity
 * watchdog and a `MAX_CONSECUTIVE_TOOL_FAILURES` abort. Neither catches the
 * failure mode where the model issues the *same successful* tool call over and
 * over — re-reading the same file, re-listing the same feed, re-querying the
 * same row — which returns no new information, produces no error, and silently
 * burns the context window until compaction fires.
 *
 * This module detects that by signature: a tool call is reduced to a canonical
 * `name:args` string (object keys sorted so argument order never matters), and
 * repeats are counted within a per-turn sliding window. Crossing a reminder
 * threshold appends an escalating advisory to the offending tool result (the
 * model sees it and can course-correct); crossing the abort threshold releases
 * the turn outright, the same lever the failure guard pulls.
 *
 * Modeled on DeepSeek Harness's `guard/repeat-tool-reminder`, adapted to our
 * `afterToolCall` hook: dsh injects a reminder message, we append to the result
 * content (the only in-turn channel the hook exposes).
 */

/** Most recent tool-call signatures kept per turn. Sized above the largest
 *  reminder/abort threshold so a genuine loop is still counted after unrelated
 *  calls interleave (e.g. an A,B,A,B oscillation). */
export const LOOP_GUARD_WINDOW = 16;

/** Repeat counts (occurrences of one signature within the window, including the
 *  current call) at which an escalating advisory is appended to the result. */
export const LOOP_GUARD_REMINDER_THRESHOLDS = [3, 5, 8] as const;

/** Repeat count at which the turn is aborted outright — a model that has made
 *  the identical call this many times is wedged, not exploring. */
export const LOOP_GUARD_ABORT_THRESHOLD = 12;

export interface LoopGuardDecision {
  /** Occurrences of this signature within the window, including the current call. */
  count: number;
  /** Advisory text to append to the tool result, set only when a reminder
   *  threshold was crossed exactly on this call. */
  reminder?: string;
  /** True once the abort threshold is reached — caller should release the turn. */
  abort: boolean;
}

/** Deterministic JSON with object keys sorted recursively, so two calls with the
 *  same arguments in a different key order collapse to the same signature. */
const stableStringify = (value: unknown): string => {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`);
  return `{${entries.join(',')}}`;
};

/** Canonical signature for a tool call: tool name + order-independent args. */
export const canonicalizeToolCall = (name: string, args: unknown): string =>
  `${name}:${stableStringify(args)}`;

const buildReminder = (name: string, count: number): string => {
  const prefix = `You have now called the \`${name}\` tool ${count} times with identical arguments, and it keeps returning the same result.`;
  if (count >= LOOP_GUARD_REMINDER_THRESHOLDS[2]) {
    return `${prefix} This is a loop — repeating it cannot produce new information. Stop calling it: either take a genuinely different action (different tool or different arguments) or give the user your best answer with what you already have. If you are stuck, say so plainly rather than retrying.`;
  }
  if (count >= LOOP_GUARD_REMINDER_THRESHOLDS[1]) {
    return `${prefix} Repeating the same call will not change the outcome. Change your approach now — use different arguments, a different tool, or move on with the information you already have.`;
  }
  return `${prefix} Repeating it will not produce new information. Change the arguments, try a different tool, or move on.`;
};

/**
 * Record a tool call in the per-turn window and decide whether to nudge or abort.
 * Mutates `window` in place (append + trim to {@link LOOP_GUARD_WINDOW}).
 */
export const recordToolCall = (window: string[], name: string, args: unknown): LoopGuardDecision => {
  const signature = canonicalizeToolCall(name, args);
  window.push(signature);
  const overflow = window.length - LOOP_GUARD_WINDOW;
  if (overflow > 0) {
    window.splice(0, overflow);
  }
  let count = 0;
  for (const entry of window) {
    if (entry === signature) {
      count += 1;
    }
  }
  const abort = count >= LOOP_GUARD_ABORT_THRESHOLD;
  return (LOOP_GUARD_REMINDER_THRESHOLDS as readonly number[]).includes(count)
    ? { count, abort, reminder: buildReminder(name, count) }
    : { count, abort };
};

/** Append the advisory as a trailing text block, preserving existing content. */
export const appendReminder = (
  content: (TextContent | ImageContent)[],
  reminder: string,
): (TextContent | ImageContent)[] => [...content, { type: 'text', text: reminder }];
