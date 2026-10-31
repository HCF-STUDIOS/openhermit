import type { AgentMessage } from '@mariozechner/pi-agent-core';
import type { AssistantMessage, TextContent, ToolCall, ToolResultMessage } from '@mariozechner/pi-ai';

import { isAssistantMessage } from './message-utils.js';

/**
 * Recovery for tool calls that an interrupted turn left unanswered.
 *
 * When the runner dies mid-turn — a process restart, an LRU eviction, an OOM —
 * after the model issued a tool call but before the tool's result was persisted,
 * the session's history keeps the `toolCall` with no matching `toolResult`. On
 * resume this is a genuinely unanswered call: `buildResumptionMessages` reads
 * only entries *since the last compaction*, so a call whose result was written
 * (pre- or post-compaction) always has that result present or folded into the
 * summary — a call with no result here was never answered, not summarized away.
 *
 * Today the request-path wire repair (`repairToolCallPairing`) simply DROPS such
 * a call, which erases the fact that the model attempted an action — so the model
 * either forgets a side effect happened or blindly retries a non-idempotent one.
 * Instead we SYNTHESIZE an error `toolResult` for each unanswered call, carrying
 * risk-calibrated guidance so the model knows whether a plain retry is safe.
 *
 * This is the mirror of the existing orphaned-*result* post-pass in
 * `buildResumptionMessages` (which fabricates a `toolCall` for a result that has
 * no call); run this *after* it so synthetic calls it created are answered too.
 *
 * Modeled on DeepSeek Harness's `ToolCallRecovery` (TOOL_NOT_STARTED vs
 * TOOL_OUTCOME_UNKNOWN). RESUME-PATH ONLY — it operates on reconstructed history,
 * never on live state, and only ever *adds* a result (it drops nothing), so it
 * cannot regress the MiniMax wire-shape repairs in `repairToolCallStructure`.
 */

/** Risk grade for an interrupted tool call. */
export type ToolCallRisk =
  /** Side-effect-free (read/list/query): the call left no trace, a plain retry is safe. */
  | 'TOOL_NOT_STARTED'
  /** May have mutated state before the interrupt: the model must verify before retrying. */
  | 'TOOL_OUTCOME_UNKNOWN';

/**
 * Known side-effect-free tools — a plain retry after an interrupt is safe. Any
 * tool NOT listed here (including every MCP/dynamic tool) is treated as
 * potentially mutating, because assuming an unknown tool is safe is the
 * dangerous default. Keep conservative: when in doubt, leave it off this list.
 */
const READ_ONLY_TOOLS = new Set<string>([
  'approval_list',
  'attachment_fetch',
  'attachment_list',
  'doc_read',
  'fetch_full_history',
  'file_list',
  'file_read',
  'file_stat',
  'mcp_status',
  'memory_get',
  'memory_list',
  'memory_recall',
  'policy_list',
  'schedule_list',
  'schedule_runs',
  'session_list',
  'session_read',
  'session_summary',
  'skill_scan',
  'user_list',
  'web_fetch',
  'web_search',
]);

/** Read-only name shapes, so a tool added later (or an MCP read tool) is graded
 *  safe without an explicit entry. Mutating verbs deliberately excluded. */
const READ_ONLY_SUFFIXES = ['_list', '_read', '_get', '_stat', '_status', '_runs'];
const READ_ONLY_PREFIXES = ['list_', 'read_', 'get_'];

/** Grade an interrupted tool call by how risky a blind retry would be. */
export const classifyToolCallRisk = (toolName: string): ToolCallRisk => {
  const name = toolName.toLowerCase();
  if (READ_ONLY_TOOLS.has(name)) return 'TOOL_NOT_STARTED';
  if (READ_ONLY_SUFFIXES.some((s) => name.endsWith(s))) return 'TOOL_NOT_STARTED';
  if (READ_ONLY_PREFIXES.some((p) => name.startsWith(p))) return 'TOOL_NOT_STARTED';
  if (name.includes('search')) return 'TOOL_NOT_STARTED';
  return 'TOOL_OUTCOME_UNKNOWN';
};

const guidanceFor = (toolName: string, risk: ToolCallRisk): string => {
  if (risk === 'TOOL_NOT_STARTED') {
    return `The \`${toolName}\` tool call was interrupted by a restart before it ran. It has no side effects, so it is safe to simply call it again if you still need the result.`;
  }
  return `The \`${toolName}\` tool call was interrupted by a restart, and it is unknown whether it took effect before the interruption. Do NOT blindly retry: first check whether the action already happened (e.g. read the current state), and only retry if it clearly did not. If you cannot tell, ask the user before repeating it.`;
};

/** Build the synthetic error result for one unanswered call. */
const synthesizeResult = (call: ToolCall, timestamp: number): ToolResultMessage => {
  const risk = classifyToolCallRisk(call.name);
  const text: TextContent = {
    type: 'text',
    text: `[interrupted: ${risk}] ${guidanceFor(call.name, risk)}`,
  };
  return {
    role: 'toolResult',
    toolCallId: call.id,
    toolName: call.name,
    content: [text],
    isError: true,
    details: { recovery: 'interrupted-tool-call', risk },
    timestamp,
  };
};

const toolCallsOf = (m: AgentMessage): ToolCall[] =>
  isAssistantMessage(m) ? (m.content.filter((b) => b.type === 'toolCall') as ToolCall[]) : [];

/**
 * Synthesize an error `toolResult` for every tool call left unanswered by an
 * interrupted turn, inserted immediately after its owning assistant message so
 * the result run stays contiguous (the shape MiniMax's `/anthropic` endpoint
 * requires). Returns the input array unchanged (same reference) when every call
 * already has a result.
 */
export const recoverInterruptedToolCalls = (messages: AgentMessage[]): AgentMessage[] => {
  const answered = new Set<string>();
  for (const m of messages) {
    if ((m as ToolResultMessage).role === 'toolResult') {
      answered.add((m as ToolResultMessage).toolCallId);
    }
  }

  let changed = false;
  const out: AgentMessage[] = [];
  for (const m of messages) {
    out.push(m);
    const calls = toolCallsOf(m);
    if (calls.length === 0) continue;
    const unanswered = calls.filter((c) => !answered.has(c.id));
    if (unanswered.length === 0) continue;
    const ts = (m as AssistantMessage).timestamp ?? Date.now();
    for (const call of unanswered) {
      out.push(synthesizeResult(call, ts));
      answered.add(call.id);
      changed = true;
    }
  }

  return changed ? out : messages;
};
