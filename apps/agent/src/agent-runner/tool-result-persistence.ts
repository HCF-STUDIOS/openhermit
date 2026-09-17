import type { AgentMessage } from '@mariozechner/pi-agent-core';
import type { ToolResultStore } from '@openhermit/store';

import type { AgentWorkspace } from '../core/index.js';

// ── Constants ──────────────────────────────────────────────────────────

/** Tool results larger than this (in chars) are persisted to disk. */
export const PERSIST_THRESHOLD_CHARS = 8_000;

/**
 * Per-result inline budget (chars) when rehydrating a RECENT tool result from
 * disk. The most recent tool outputs are the ones the model is actively
 * reasoning about, so we give them a much larger inline view than the ~4.5K
 * production preview — closer to opencode/pi, which keep recent tool output
 * verbatim — while still bounding the footprint (the full text stays on disk
 * and is fetchable via `read_file`).
 */
export const RECENT_TOOL_RESULT_PREVIEW_CHARS = 20_000;

/**
 * Total inline budget (chars) across ALL rehydrated recent tool results in a
 * single request. Caps how much history the rehydration can re-inflate no
 * matter how many recent results are offloaded — only the newest few (walking
 * back from the tail) are expanded, up to this total.
 */
export const RECENT_TOOL_RESULT_TOTAL_BUDGET_CHARS = 60_000;

/** Characters kept from the head of the content for the inline preview. */
export const PREVIEW_HEAD_CHARS = 3_000;

/** Characters kept from the tail of the content for the inline preview. */
export const PREVIEW_TAIL_CHARS = 1_500;

const TOOL_RESULTS_DIR = '.openhermit/tool_results';

// ── Head + tail preview ────────────────────────────────────────────────

/**
 * Build a head+tail preview of a long string.
 * Returns the original text unchanged when it fits within the budget.
 */
export const createHeadTailPreview = (
  text: string,
  headChars: number = PREVIEW_HEAD_CHARS,
  tailChars: number = PREVIEW_TAIL_CHARS,
): string => {
  const budget = headChars + tailChars;
  if (text.length <= budget) return text;

  // Try to break at a newline so we don't slice mid-line.
  const headCut = findNewlineBefore(text, headChars);
  const tailCut = findNewlineAfter(text, text.length - tailChars);
  const omitted = tailCut - headCut;

  const head = text.slice(0, headCut);
  const tail = text.slice(tailCut);
  return `${head}\n\n[... ${omitted.toLocaleString()} characters omitted ...]\n\n${tail}`;
};

/** Find the last newline at or before `pos`, but no earlier than 80% of `pos`. */
const findNewlineBefore = (text: string, pos: number): number => {
  const floor = Math.floor(pos * 0.8);
  const idx = text.lastIndexOf('\n', pos);
  return idx >= floor ? idx : pos;
};

/** Find the first newline at or after `pos`, but no later than `pos + 20%` of remaining. */
const findNewlineAfter = (text: string, pos: number): number => {
  const ceiling = pos + Math.floor((text.length - pos) * 0.2);
  const idx = text.indexOf('\n', pos);
  return idx !== -1 && idx <= ceiling ? idx : pos;
};

// ── File persistence ───────────────────────────────────────────────────

/** Build the workspace-relative path for a persisted tool result. */
export const toolResultPath = (toolCallId: string): string =>
  `${TOOL_RESULTS_DIR}/${toolCallId}.json`;

/**
 * Check whether a tool result exceeds the persistence threshold and, if so,
 * return a synchronous preview string.  The actual file write should happen
 * separately (e.g. inside `queueSideEffect`).
 *
 * Returns `null` when the text is short enough and needs no truncation.
 */
export const buildToolResultPreview = (
  toolCallId: string,
  fullText: string,
): { preview: string; filePath: string } | null => {
  if (fullText.length <= PERSIST_THRESHOLD_CHARS) return null;

  const filePath = toolResultPath(toolCallId);
  const preview = createHeadTailPreview(fullText);
  const footer = `\n\n[Output truncated — full text (${fullText.length.toLocaleString()} chars) saved to workspace/${filePath}. Use read_file to view the complete content if needed.]`;

  return { preview: preview + footer, filePath };
};

/**
 * Persist the full tool result content to the workspace file and, when a
 * durable `store` is provided, mirror it to blob storage (keyed by agent +
 * tool-call id) so a fresh gateway with an empty workspace can restore it.
 *
 * The blob mirror is best-effort: the local write already succeeded, so a blob
 * failure is swallowed rather than surfaced — durability is an optimization,
 * not a correctness requirement for the current session.
 */
export const persistToolResult = async (
  workspace: AgentWorkspace,
  toolCallId: string,
  fullText: string,
  opts?: { store?: ToolResultStore; agentId?: string },
): Promise<void> => {
  await workspace.writeFile(toolResultPath(toolCallId), fullText);
  if (opts?.store && opts.agentId) {
    try {
      await opts.store.put(opts.agentId, toolCallId, fullText);
    } catch {
      // Best-effort durable mirror; the local copy is authoritative this session.
    }
  }
};

// ── Recent tool-result rehydration ─────────────────────────────────────

/**
 * Expand the most recent offloaded tool results back to a larger inline
 * preview by re-reading their full text from disk. Walks messages newest-first
 * and expands tool results until the per-request total budget is exhausted, so
 * only the newest few (the ones the model is actively working with) grow; older
 * results keep their small production preview.
 *
 * Best-effort: a tool result whose disk file is missing (never offloaded, or an
 * ephemeral workspace after resume) is left untouched. Returns the (possibly
 * new) message list plus the set of indices that were expanded, so the caller
 * can protect them from the downstream `truncateToolResults` cap.
 */
export const rehydrateRecentToolResults = async (
  workspace: AgentWorkspace,
  messages: AgentMessage[],
  opts?: {
    perResultChars?: number;
    totalBudgetChars?: number;
    store?: ToolResultStore;
    agentId?: string;
  },
): Promise<{ messages: AgentMessage[]; protectedIndices: Set<number> }> => {
  const perResultChars = opts?.perResultChars ?? RECENT_TOOL_RESULT_PREVIEW_CHARS;
  const totalBudgetChars = opts?.totalBudgetChars ?? RECENT_TOOL_RESULT_TOTAL_BUDGET_CHARS;
  const store = opts?.store;
  const agentId = opts?.agentId;
  const protectedIndices = new Set<number>();

  if (perResultChars <= 0 || totalBudgetChars <= 0) {
    return { messages, protectedIndices };
  }

  let used = 0;
  let result: AgentMessage[] | undefined;

  for (let i = messages.length - 1; i >= 0 && used < totalBudgetChars; i -= 1) {
    const message = messages[i]!;
    if (message.role !== 'toolResult') continue;

    const toolCallId = (message as { toolCallId?: string }).toolCallId;
    if (!toolCallId) continue;

    let fullText: string;
    try {
      fullText = await workspace.readFile(toolResultPath(toolCallId));
    } catch {
      // Local miss: either the result was never offloaded (already small), or
      // the workspace copy is gone (ephemeral workspace after a volume-free
      // restart). Fall back to the durable blob copy when configured, and
      // restore it locally so a later `read_file` on the same path also hits.
      if (!store || !agentId) continue;
      const restored = await store.get(agentId, toolCallId);
      if (restored === null) continue;
      fullText = restored;
      try {
        await workspace.writeFile(toolResultPath(toolCallId), restored);
      } catch {
        // Restore-to-cache is best-effort; we still expand from `restored`.
      }
    }

    const currentChars = message.content.reduce(
      (sum, item) => (item.type === 'text' ? sum + item.text.length : sum),
      0,
    );

    const budget = Math.min(perResultChars, totalBudgetChars - used);
    // Only expand when it buys a materially larger view than what's inline now.
    if (budget <= currentChars) continue;

    const headChars = Math.floor(budget * 0.7);
    const tailChars = budget - headChars;
    const preview = createHeadTailPreview(fullText, headChars, tailChars);
    const footer = fullText.length > preview.length
      ? `\n\n[Recent tool result — showing ~${budget.toLocaleString()} of ${fullText.length.toLocaleString()} chars; full text at workspace/${toolResultPath(toolCallId)}, fetchable via read_file.]`
      : '';
    const text = preview + footer;

    // Preserve any non-text items (e.g. images) the tool result carried; only
    // the text portion was ever offloaded to disk.
    const nonTextItems = message.content.filter((item) => item.type !== 'text');

    result ??= [...messages];
    result[i] = {
      ...message,
      content: [{ type: 'text', text }, ...nonTextItems],
    } as AgentMessage;
    used += text.length;
    protectedIndices.add(i);
  }

  return { messages: result ?? messages, protectedIndices };
};
