import type { Agent, AgentMessage } from '@mariozechner/pi-agent-core';
import type { InternalStateStore, StoreScope } from '@openhermit/store';

import type { AgentConfig } from '../core/index.js';
import { extractAssistantText } from './message-utils.js';
import { resolveModel } from './model-utils.js';
import { createHeadTailPreview } from './tool-result-persistence.js';

// ── Constants ──────────────────────────────────────────────────────────

export const DEFAULT_CONTEXT_COMPACTION_RECENT_MESSAGE_COUNT = 6;

export const DEFAULT_CONTEXT_COMPACTION_SUMMARY_MAX_CHARS = 2_400;

export const DEFAULT_CONTEXT_COMPACTION_SAFETY_MARGIN_TOKENS = 2_048;

// Hard ceiling on the auto-derived compaction threshold. Without this,
// models with huge context windows (e.g. Gemini's 1M) would only compact
// at ~1M input tokens — single turns hit 700K+ tokens before kicking in.
// Users with explicit `contextCompactionMaxTokens` set can still raise it.
export const DEFAULT_CONTEXT_COMPACTION_MAX_TOKENS_CEILING = 160_000;

// Secondary trigger: regardless of token estimate, compact when the
// message list grows past this count. A long history of small messages
// (tool ping-pong, image attachments, etc.) can stay below the token
// ceiling and never trigger compaction, leaving 400+ messages on the
// wire — which kills prompt caching and inflates per-turn latency.
export const DEFAULT_CONTEXT_COMPACTION_MAX_MESSAGES = 80;

// ── Token estimation ───────────────────────────────────────────────────

export const estimateTextTokens = (text: string): number =>
  Math.max(1, Math.ceil(text.length / 4));

export const estimateContentTokens = (content: unknown): number => {
  if (typeof content === 'string') {
    return estimateTextTokens(content);
  }

  if (!Array.isArray(content)) {
    return estimateTextTokens(JSON.stringify(content));
  }

  return content.reduce((total, item) => {
    if (!item || typeof item !== 'object' || !('type' in item)) {
      return total + estimateTextTokens(JSON.stringify(item));
    }

    if (item.type === 'text' && typeof item.text === 'string') {
      return total + estimateTextTokens(item.text);
    }

    if (item.type === 'thinking' && typeof item.thinking === 'string') {
      return total + estimateTextTokens(item.thinking);
    }

    if (item.type === 'toolCall') {
      return (
        total +
        estimateTextTokens(
          `${item.name ?? ''} ${JSON.stringify(item.arguments ?? {})}`,
        )
      );
    }

    if (item.type === 'image') {
      return total + 256;
    }

    return total + estimateTextTokens(JSON.stringify(item));
  }, 0);
};

export const estimateAgentMessageTokens = (message: AgentMessage): number => {
  if (!message || typeof message !== 'object' || !('role' in message)) {
    return estimateTextTokens(JSON.stringify(message));
  }

  if (message.role === 'user' || message.role === 'assistant') {
    return estimateContentTokens(message.content) + 12;
  }

  if (message.role === 'toolResult') {
    return estimateContentTokens(message.content) + 20;
  }

  return estimateTextTokens(JSON.stringify(message));
};

export const estimateAgentMessagesTokens = (messages: AgentMessage[]): number =>
  messages.reduce((total, message) => total + estimateAgentMessageTokens(message), 0);

/**
 * Estimate the fixed-overhead tokens that get sent on every LLM call:
 * the system prompt and the serialized tool catalog. Without this,
 * compaction's budget comparison only sees message tokens — but real
 * payloads also carry a 28K-char system prompt + 50K-char tools catalog
 * that together add ~20K tokens, pushing the actual request well above
 * a 160K "messages" budget while compaction thinks it's safe.
 */
export const estimateFixedOverheadTokens = (input: {
  systemPrompt?: string | undefined;
  tools?: ReadonlyArray<unknown> | undefined;
}): number => {
  let total = 0;
  if (input.systemPrompt) {
    total += estimateTextTokens(input.systemPrompt);
  }
  if (input.tools && input.tools.length > 0) {
    // Tool definitions are serialized to JSON on the wire (name +
    // description + parameter schema). Stringify each tool individually
    // so a circular ref in one entry doesn't take down the whole
    // estimate.
    for (const tool of input.tools) {
      try {
        total += estimateTextTokens(JSON.stringify(tool));
      } catch {
        total += 256; // fallback placeholder
      }
    }
  }
  return total;
};

// ── Per-message truncation ────────────────────────────────────────────

/**
 * Max share of the context window a single tool result may occupy,
 * applied at LLM-call time. Bounded above by `TOOL_RESULT_MAX_CHARS_CAP`
 * so that on huge-context models (e.g. 256K kimi, 1M gemini) a single
 * tool result can't quietly consume tens of thousands of tokens of
 * history slot.
 */
export const TOOL_RESULT_MAX_CONTEXT_RATIO = 0.25;

/**
 * Absolute cap (in chars) for any individual tool result inlined in the
 * LLM request. Matches the persistence threshold in
 * `tool-result-persistence.ts` — anything bigger has already been written
 * to disk under workspace/.openhermit/tool_results/<id>.json, so the
 * agent can pull the full text via `read_file` on demand. The previous
 * ratio-only formula let a 55K-char document fit comfortably under a
 * 64K-char per-call budget and sit in history forever; this cap keeps
 * the inline footprint bounded regardless of context window size.
 */
export const TOOL_RESULT_MAX_CHARS_CAP = 8_000;

export const truncateToolResults = (
  messages: AgentMessage[],
  contextWindow: number,
): AgentMessage[] => {
  const maxChars = Math.min(
    TOOL_RESULT_MAX_CHARS_CAP,
    Math.floor(contextWindow * TOOL_RESULT_MAX_CONTEXT_RATIO * 4), // tokens × ~4 chars/token
  );

  return messages.map((message) => {
    if (message.role !== 'toolResult') {
      return message;
    }

    const totalChars = message.content.reduce((sum, item) => {
      if (item.type === 'text') {
        return sum + item.text.length;
      }
      return sum;
    }, 0);

    if (totalChars <= maxChars) {
      return message;
    }

    // Use 70% of the budget for the head and 30% for the tail so that
    // error messages and summaries near the end are preserved.
    const headBudget = Math.floor(maxChars * 0.7);
    const tailBudget = maxChars - headBudget;

    let remaining = maxChars;
    const truncatedContent = message.content.map((item) => {
      if (item.type !== 'text' || remaining <= 0) {
        return remaining <= 0 ? { type: 'text' as const, text: '' } : item;
      }
      if (item.text.length <= remaining) {
        remaining -= item.text.length;
        return item;
      }
      const preview = createHeadTailPreview(item.text, headBudget, tailBudget);
      remaining = 0;
      return {
        type: 'text' as const,
        text: `${preview}\n\n[truncated: original ${totalChars.toLocaleString()} chars, kept ~${maxChars.toLocaleString()}]`,
      };
    });

    return { ...message, content: truncatedContent };
  });
};

// ── Pure helpers ───────────────────────────────────────────────────────

export const getCompactionRetainedStartIndex = (
  messages: AgentMessage[],
  retainCount: number,
): number => {
  let startIndex = Math.max(0, messages.length - retainCount);

  if (
    startIndex > 0
    && messages[startIndex]?.role === 'toolResult'
    && messages[startIndex - 1]?.role === 'assistant'
  ) {
    startIndex -= 1;
  }

  return startIndex;
};

export const summarizeMessageForCompaction = (message: AgentMessage): string | undefined => {
  if (!message || typeof message !== 'object' || !('role' in message)) {
    return undefined;
  }

  if (message.role === 'user') {
    const text =
      typeof message.content === 'string'
        ? message.content
        : message.content
            .filter((item): item is Extract<typeof item, { type: 'text' }> => item.type === 'text')
            .map((item) => item.text)
            .join(' ');

    const normalized = text.replace(/\s+/g, ' ').trim();
    return normalized ? `User: ${normalized}` : undefined;
  }

  if (message.role === 'assistant') {
    const text = message.content
      .filter((item): item is Extract<typeof item, { type: 'text' }> => item.type === 'text')
      .map((item) => item.text)
      .join(' ');
    const toolCalls = message.content
      .filter((item): item is Extract<typeof item, { type: 'toolCall' }> => item.type === 'toolCall')
      .map((item) => item.name)
      .join(', ');
    const normalized = text.replace(/\s+/g, ' ').trim();

    if (normalized) {
      return `Agent: ${normalized}`;
    }

    if (toolCalls) {
      return `Agent used tools: ${toolCalls}`;
    }

    return undefined;
  }

  if (message.role === 'toolResult') {
    const text = message.content
      .filter((item): item is Extract<typeof item, { type: 'text' }> => item.type === 'text')
      .map((item) => item.text)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();

    return text
      ? `Tool ${message.toolName}: ${text}`
      : `Tool ${message.toolName} completed.`;
  }

  return undefined;
};

// ── Budget helpers ─────────────────────────────────────────────────────

export interface CompactionOptions {
  contextCompactionMaxTokens?: number | undefined;
  contextCompactionRecentMessageCount?: number | undefined;
  contextCompactionSummaryMaxChars?: number | undefined;
  /**
   * Secondary trigger — when the post-context message list grows past
   * this count, compact even if the token estimate is still under
   * budget. Default `DEFAULT_CONTEXT_COMPACTION_MAX_MESSAGES`.
   */
  contextCompactionMaxMessages?: number | undefined;
  /**
   * Pre-computed fixed overhead (system prompt + serialized tools) that
   * will be sent on every LLM call. Subtracted from the budget so the
   * compaction decision reflects the real wire payload, not just the
   * messages portion. Caller is expected to compute this via
   * `estimateFixedOverheadTokens` once per turn.
   */
  fixedOverheadTokens?: number | undefined;
}

export const getContextCompactionMaxTokens = (
  config: AgentConfig,
  options: CompactionOptions,
): number => {
  if (options.contextCompactionMaxTokens !== undefined) {
    return options.contextCompactionMaxTokens;
  }

  const model = resolveModel(config);
  const reservedOutputTokens = Math.max(
    config.model.max_tokens,
    Math.min(model.maxTokens, 1_024),
  );

  return Math.max(
    2_048,
    Math.min(
      DEFAULT_CONTEXT_COMPACTION_MAX_TOKENS_CEILING,
      model.contextWindow
      - reservedOutputTokens
      - DEFAULT_CONTEXT_COMPACTION_SAFETY_MARGIN_TOKENS,
    ),
  );
};

export const getContextCompactionRecentMessageCount = (
  options: CompactionOptions,
): number =>
  options.contextCompactionRecentMessageCount
    ?? DEFAULT_CONTEXT_COMPACTION_RECENT_MESSAGE_COUNT;

export const getContextCompactionSummaryMaxChars = (
  options: CompactionOptions,
): number =>
  options.contextCompactionSummaryMaxChars
    ?? DEFAULT_CONTEXT_COMPACTION_SUMMARY_MAX_CHARS;

export const getContextCompactionMaxMessages = (
  options: CompactionOptions,
): number =>
  options.contextCompactionMaxMessages
    ?? DEFAULT_CONTEXT_COMPACTION_MAX_MESSAGES;

// ── LLM compaction summary ────────────────────────────────────────────

export type CreateCompactionAgentFn = (sessionId: string) => Promise<Agent>;

const parseCompactionSummaryResponse = (
  text: string | undefined,
): string | undefined => {
  if (!text) {
    return undefined;
  }

  const trimmed = text.trim();
  const jsonText = trimmed.startsWith('```')
    ? trimmed
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/, '')
        .trim()
    : trimmed;

  try {
    const parsed = JSON.parse(jsonText) as { compactionSummary?: unknown };

    if (typeof parsed.compactionSummary === 'string') {
      const normalized = parsed.compactionSummary.trim();
      return normalized.length > 0 ? normalized : undefined;
    }
  } catch {
    // Not JSON — treat the whole response as the summary.
    return trimmed.length > 0 ? trimmed : undefined;
  }

  return undefined;
};

export const runCompactionSummaryTurn = async (input: {
  sessionId: string;
  compactedMessages: AgentMessage[];
  previousCompactionSummary: string | undefined;
  createAgent: CreateCompactionAgentFn;
}): Promise<string | undefined> => {
  const textSummaries = input.compactedMessages
    .map((message) => summarizeMessageForCompaction(message))
    .filter((line): line is string => Boolean(line));

  if (textSummaries.length === 0) {
    return undefined;
  }

  const transcript = textSummaries.join('\n').slice(0, 16_000);

  const promptParts = [
    'Internal compaction turn:',
    '- This is an internal runtime turn, not a user-facing reply.',
    '- Summarize the compacted conversation below into a coherent narrative.',
    '- Capture: key topics discussed, decisions made, important file paths or data, outstanding tasks or questions.',
    '- Be concise but preserve important context that will help the agent continue the conversation.',
    '- Return JSON only with key "compactionSummary".',
    '- Do not call tools.',
    '- Do not wrap the JSON in markdown fences.',
  ];

  const userParts = [
    `Session: ${input.sessionId}`,
  ];

  if (input.previousCompactionSummary) {
    userParts.push(
      'Previous compaction summary (incorporate and update):',
      input.previousCompactionSummary,
    );
  }

  userParts.push(
    'Compacted messages to summarize:',
    transcript,
  );

  const agent = await input.createAgent(input.sessionId);

  await agent.prompt({
    role: 'user',
    content: [{ type: 'text', text: userParts.join('\n\n') }],
    timestamp: Date.now(),
  });
  await agent.waitForIdle();

  const assistantMessage = [...agent.state.messages]
    .reverse()
    .find((message) => message.role === 'assistant');
  const responseText = assistantMessage
    ? extractAssistantText(assistantMessage)
    : undefined;

  return parseCompactionSummaryResponse(responseText);
};

// ── Compaction block builder ───────────────────────────────────────────

export const buildContextCompactionBlock = (input: {
  compactedMessages: AgentMessage[];
  retainedMessageCount: number;
  originalMessageCount: number;
  llmSummary: string | undefined;
  options: CompactionOptions;
}): AgentMessage | undefined => {
  if (input.compactedMessages.length === 0) {
    return undefined;
  }

  const parts = [
    'Context compaction summary (runtime-generated, read-only context):',
    '',
  ];

  if (input.llmSummary) {
    parts.push(input.llmSummary, '');
  }

  parts.push(
    `Earlier messages compacted: ${input.compactedMessages.length} of ${input.originalMessageCount}`,
    `Recent messages preserved verbatim: ${input.retainedMessageCount}`,
  );

  if (!input.llmSummary) {
    // Fallback: include text-extraction summaries when LLM summary is unavailable.
    const summaryMaxChars = getContextCompactionSummaryMaxChars(input.options);
    const compactedLines = input.compactedMessages
      .map((message) => summarizeMessageForCompaction(message))
      .filter((line): line is string => Boolean(line))
      .slice(-12);
    const compactedHistory = compactedLines
      .join('\n- ')
      .slice(0, summaryMaxChars);

    parts.push(
      '',
      'Compacted earlier session history:',
      compactedHistory ? `- ${compactedHistory}` : '- (no compactable text)',
    );
  }

  const text = parts.join('\n').trim();

  return {
    role: 'user',
    content: [{ type: 'text', text }],
    timestamp: Date.now(),
  };
};

// ── Main compaction orchestration ──────────────────────────────────────

export interface CompactionDeps {
  store: InternalStateStore;
  scope: StoreScope;
  options: CompactionOptions;
  createCompactionAgent?: CreateCompactionAgentFn | undefined;
  logRuntime: (message: string) => void;
}

export const compactContextIfNeeded = async (
  sessionId: string,
  config: AgentConfig,
  contextBlocks: AgentMessage[],
  messages: AgentMessage[],
  deps: CompactionDeps,
): Promise<AgentMessage[]> => {
  const combined = contextBlocks.concat(messages);
  const budget = getContextCompactionMaxTokens(config, deps.options);
  const overhead = deps.options.fixedOverheadTokens ?? 0;
  const maxMessages = getContextCompactionMaxMessages(deps.options);

  // Decision sees the real wire payload: messages + system prompt +
  // tools. The previous budget-only check ignored ~20K of overhead and
  // never triggered when the messages portion sat just under 160K.
  const effectiveTokens = (msgs: AgentMessage[]) =>
    estimateAgentMessagesTokens(msgs) + overhead;

  const overflowTokens = effectiveTokens(combined) > budget;
  const overflowCount = messages.length > maxMessages;

  if (messages.length <= 1 || (!overflowTokens && !overflowCount)) {
    return combined;
  }

  const retainCountOption = getContextCompactionRecentMessageCount(deps.options);
  let retainCount = Math.min(retainCountOption, messages.length);

  const buildCandidate = (
    nextRetainCount: number,
    llmSummary: string | undefined,
  ): AgentMessage[] => {
    const retainedStartIndex = getCompactionRetainedStartIndex(messages, nextRetainCount);
    const compactedMessages = messages.slice(0, retainedStartIndex);
    const retainedMessages = messages.slice(retainedStartIndex);
    const compactionBlock = buildContextCompactionBlock({
      compactedMessages,
      retainedMessageCount: retainedMessages.length,
      originalMessageCount: messages.length,
      llmSummary,
      options: deps.options,
    });

    return contextBlocks.concat(
      compactionBlock ? [compactionBlock] : [],
      retainedMessages,
    );
  };

  // First pass: find the retain count without LLM summary (text-extraction only).
  let compacted = buildCandidate(retainCount, undefined);

  while (
    (effectiveTokens(compacted) > budget || compacted.length > maxMessages)
    && retainCount > 1
  ) {
    retainCount -= 1;
    compacted = buildCandidate(retainCount, undefined);
  }

  // Expansion phase: grow retainCount as long as we stay under the
  // token budget AND under the message-count cap. Without the count
  // cap, count-only triggers (lots of tiny messages well below budget)
  // would expand right back to the full list and undo the compaction.
  while (retainCount < messages.length) {
    const expanded = buildCandidate(retainCount + 1, undefined);

    if (effectiveTokens(expanded) > budget || expanded.length > maxMessages) {
      break;
    }

    retainCount += 1;
    compacted = expanded;
  }

  // Determine compacted messages for LLM summary.
  const retainedStartIndex = getCompactionRetainedStartIndex(messages, retainCount);
  const compactedMessages = messages.slice(0, retainedStartIndex);

  // Attempt LLM-powered summary if we have compacted messages and an agent factory.
  let llmSummary: string | undefined;

  if (compactedMessages.length > 0 && deps.createCompactionAgent) {
    try {
      // Load persisted compaction summary for progressive compaction.
      const previousSummary = await deps.store.messages.getCompactionSummary(deps.scope, sessionId);

      llmSummary = await runCompactionSummaryTurn({
        sessionId,
        compactedMessages,
        previousCompactionSummary: previousSummary,
        createAgent: deps.createCompactionAgent,
      });

      if (llmSummary) {
        // Persist for next compaction pass.
        await deps.store.messages.setCompactionSummary(
          deps.scope,
          sessionId,
          llmSummary,
          new Date().toISOString(),
        );
      }
    } catch (error) {
      deps.logRuntime(
        `compaction LLM summary failed, falling back to text extraction: ${String(error)}`,
      );
    }
  } else if (compactedMessages.length > 0 && !deps.createCompactionAgent) {
    // No agent factory — try to use a previously persisted summary.
    try {
      llmSummary = await deps.store.messages.getCompactionSummary(deps.scope, sessionId);
    } catch {
      // Ignore — text-extraction fallback.
    }
  }

  // Rebuild with the LLM summary (or undefined for text-extraction fallback).
  compacted = buildCandidate(retainCount, llmSummary);

  const beforeTokens = estimateAgentMessagesTokens(combined);
  const compactedTokens = estimateAgentMessagesTokens(compacted);

  // If compaction was triggered only by message count (tokens still
  // under budget), accept a wash on tokens as long as message count
  // actually shrank — the goal there is to bound list length, not
  // tokens.
  const tokenWin = compactedTokens < beforeTokens;
  const countWin = compacted.length < combined.length;
  if (!tokenWin && !countWin) {
    return combined;
  }

  const reason = overflowTokens && overflowCount
    ? 'tokens+count'
    : overflowTokens
      ? 'tokens'
      : 'count';
  deps.logRuntime(
    `context compacted: ${sessionId} estimated ${beforeTokens} -> ${compactedTokens} tokens, ${combined.length} -> ${compacted.length} msgs, trigger=${reason}, overhead=${overhead}${llmSummary ? ' (LLM summary)' : ' (text extraction)'}`,
  );

  return compacted;
};
