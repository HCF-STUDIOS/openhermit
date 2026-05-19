import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { AgentMessage } from '@mariozechner/pi-agent-core';
import type { Api, Provider, StopReason, Usage } from '@mariozechner/pi-ai';

import {
  estimateTextTokens,
  estimateContentTokens,
  estimateAgentMessageTokens,
  estimateAgentMessagesTokens,
  estimateFixedOverheadTokens,
  getCompactionRetainedStartIndex,
  summarizeMessageForCompaction,
  buildContextCompactionBlock,
  compactContextIfNeeded,
  truncateToolResults,
  TOOL_RESULT_MAX_CONTEXT_RATIO,
  TOOL_RESULT_MAX_CHARS_CAP,
  getContextCompactionMaxTokens,
  getContextCompactionMaxMessages,
  getContextCompactionRecentMessageCount,
  getContextCompactionSummaryMaxChars,
  DEFAULT_CONTEXT_COMPACTION_RECENT_MESSAGE_COUNT,
  DEFAULT_CONTEXT_COMPACTION_SUMMARY_MAX_CHARS,
  DEFAULT_CONTEXT_COMPACTION_SAFETY_MARGIN_TOKENS,
  DEFAULT_CONTEXT_COMPACTION_MAX_MESSAGES,
  runCompactionSummaryTurn,
  type CompactionDeps,
  type CompactionOptions,
} from '../src/agent-runner/context-compaction.js';
import type { AgentConfig } from '../src/core/types.js';

// ── Helpers ────────────────────────────────────────────────────────────

const makeUserMessage = (text: string, ts = Date.now()): AgentMessage => ({
  role: 'user',
  content: [{ type: 'text', text }],
  timestamp: ts,
});

const stubUsage: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  },
};

const assistantDefaults = {
  api: 'anthropic-messages' as Api,
  provider: 'anthropic' as Provider,
  model: 'claude-sonnet-4-20250514',
  usage: stubUsage,
  stopReason: 'stop' as StopReason,
};

const makeAssistantMessage = (text: string, ts = Date.now()): AgentMessage => ({
  role: 'assistant',
  content: [{ type: 'text', text }],
  ...assistantDefaults,
  timestamp: ts,
});

const makeToolCallMessage = (toolName: string, ts = Date.now()): AgentMessage => ({
  role: 'assistant',
  content: [
    { type: 'toolCall', id: `call-${toolName}`, name: toolName, arguments: {} },
  ],
  ...assistantDefaults,
  timestamp: ts,
});

const makeToolResultMessage = (toolName: string, text: string, ts = Date.now()): AgentMessage => ({
  role: 'toolResult',
  toolCallId: `call-${toolName}`,
  toolName,
  content: [{ type: 'text', text }],
  isError: false,
  timestamp: ts,
});

const stubConfig: AgentConfig = {
  workspace_root: '/workspace',
  model: { provider: 'anthropic', model: 'claude-sonnet-4-20250514', max_tokens: 4096 },
  memory: {},
};

const createStubDeps = (overrides?: Partial<CompactionDeps>): CompactionDeps => ({
  store: {
    messages: {
      getCompactionSummary: async () => undefined,
      setCompactionSummary: async () => {},
    },
  } as unknown as CompactionDeps['store'],
  scope: { agentId: 'test-agent' },
  options: {
    contextCompactionMaxTokens: 200,
    contextCompactionRecentMessageCount: 2,
    contextCompactionSummaryMaxChars: 800,
  },
  logRuntime: () => {},
  ...overrides,
});

// ── Token estimation ───────────────────────────────────────────────────

test('estimateTextTokens returns at least 1 for empty string', () => {
  assert.equal(estimateTextTokens(''), 1);
});

test('estimateTextTokens approximates 4 chars per token', () => {
  assert.equal(estimateTextTokens('abcdefgh'), 2);
  assert.equal(estimateTextTokens('a'.repeat(100)), 25);
});

test('estimateAgentMessageTokens includes role overhead', () => {
  const user = makeUserMessage('hello');
  const tokens = estimateAgentMessageTokens(user);
  assert.ok(tokens > estimateTextTokens('hello'));
});

test('estimateAgentMessagesTokens sums all messages', () => {
  const messages = [makeUserMessage('a'), makeAssistantMessage('b')];
  const total = estimateAgentMessagesTokens(messages);
  assert.equal(
    total,
    estimateAgentMessageTokens(messages[0]!) + estimateAgentMessageTokens(messages[1]!),
  );
});

// ── getCompactionRetainedStartIndex ────────────────────────────────────

test('getCompactionRetainedStartIndex retains the last N messages', () => {
  const messages = [
    makeUserMessage('a'),
    makeAssistantMessage('b'),
    makeUserMessage('c'),
    makeAssistantMessage('d'),
  ];
  assert.equal(getCompactionRetainedStartIndex(messages, 2), 2);
});

test('getCompactionRetainedStartIndex pulls back to include assistant before toolResult', () => {
  const messages = [
    makeUserMessage('a'),
    makeToolCallMessage('exec'),
    makeToolResultMessage('exec', 'done'),
    makeUserMessage('c'),
  ];
  // retainCount=2 → startIndex=2, but messages[2] is toolResult and messages[1] is assistant
  assert.equal(getCompactionRetainedStartIndex(messages, 2), 1);
});

// ── summarizeMessageForCompaction ──────────────────────────────────────

test('summarizeMessageForCompaction formats user message', () => {
  const result = summarizeMessageForCompaction(makeUserMessage('hello world'));
  assert.equal(result, 'User: hello world');
});

test('summarizeMessageForCompaction formats assistant text', () => {
  const result = summarizeMessageForCompaction(makeAssistantMessage('reply here'));
  assert.equal(result, 'Agent: reply here');
});

test('summarizeMessageForCompaction formats tool-only assistant', () => {
  const result = summarizeMessageForCompaction(makeToolCallMessage('exec'));
  assert.equal(result, 'Agent used tools: exec');
});

test('summarizeMessageForCompaction formats tool result', () => {
  const result = summarizeMessageForCompaction(makeToolResultMessage('exec', 'output'));
  assert.equal(result, 'Tool exec: output');
});

test('summarizeMessageForCompaction returns undefined for unknown role', () => {
  const result = summarizeMessageForCompaction({ role: 'unknown' } as unknown as AgentMessage);
  assert.equal(result, undefined);
});

// ── buildContextCompactionBlock ────────────────────────────────────────

test('buildContextCompactionBlock returns undefined for empty compacted messages', () => {
  const result = buildContextCompactionBlock({
    compactedMessages: [],

    retainedMessageCount: 5,
    originalMessageCount: 5,
    llmSummary: undefined,
    options: {},
  });
  assert.equal(result, undefined);
});

test('buildContextCompactionBlock includes LLM summary when present', () => {
  const result = buildContextCompactionBlock({
    compactedMessages: [makeUserMessage('old message')],

    retainedMessageCount: 3,
    originalMessageCount: 4,
    llmSummary: 'The user discussed project architecture.',
    options: {},
  });
  assert.ok(result);
  const text = JSON.stringify(result.content);
  assert.ok(text.includes('The user discussed project architecture'));
  assert.ok(text.includes('Earlier messages compacted: 1 of 4'));
  // Should NOT include text-extraction fallback when LLM summary is present.
  assert.ok(!text.includes('Compacted earlier session history'));
});

test('buildContextCompactionBlock falls back to text extraction without LLM summary', () => {
  const result = buildContextCompactionBlock({
    compactedMessages: [makeUserMessage('hello'), makeAssistantMessage('world')],

    retainedMessageCount: 2,
    originalMessageCount: 4,
    llmSummary: undefined,
    options: {},
  });
  assert.ok(result);
  const text = JSON.stringify(result.content);
  assert.ok(text.includes('Compacted earlier session history'));
  assert.ok(text.includes('User: hello'));
});

// ── compactContextIfNeeded ─────────────────────────────────────────────

test('compactContextIfNeeded returns combined when under budget', async () => {
  const context = [makeUserMessage('ctx')];
  const messages = [makeUserMessage('a'), makeAssistantMessage('b')];
  const deps = createStubDeps({
    options: { contextCompactionMaxTokens: 100_000 },
  });

  const result = await compactContextIfNeeded('s1', stubConfig, context, messages, deps);
  assert.equal(result.length, 3);
});

test('compactContextIfNeeded returns combined when only 1 message', async () => {
  const context: AgentMessage[] = [];
  const messages = [makeUserMessage('a'.repeat(10_000))];
  const deps = createStubDeps({
    options: { contextCompactionMaxTokens: 10 },
  });

  const result = await compactContextIfNeeded('s1', stubConfig, context, messages, deps);
  assert.equal(result.length, 1);
});

test('compactContextIfNeeded compacts when over budget', async () => {
  const longText = 'word '.repeat(200).trim();
  const messages = [
    makeUserMessage(longText),
    makeAssistantMessage(longText),
    makeUserMessage(longText),
    makeAssistantMessage(longText),
    makeUserMessage('final question'),
    makeAssistantMessage('final answer'),
  ];
  const deps = createStubDeps({
    options: {
      contextCompactionMaxTokens: 800,
      contextCompactionRecentMessageCount: 2,
    },
  });

  const result = await compactContextIfNeeded('s1', stubConfig, [], messages, deps);
  // Should have fewer messages than original.
  assert.ok(result.length < messages.length);
  // Should include the compaction summary block.
  assert.ok(
    result.some(
      (m) => m.role === 'user' && JSON.stringify(m.content).includes('Context compaction summary'),
    ),
  );
  // Should preserve recent messages.
  assert.ok(
    result.some(
      (m) => m.role === 'assistant' && JSON.stringify(m.content).includes('final answer'),
    ),
  );
});

test('compactContextIfNeeded uses persisted summary when no agent factory', async () => {
  const longText = 'word '.repeat(200).trim();
  const messages = [
    makeUserMessage(longText),
    makeAssistantMessage(longText),
    makeUserMessage('recent'),
  ];
  const deps = createStubDeps({
    options: {
      contextCompactionMaxTokens: 200,
      contextCompactionRecentMessageCount: 1,
    },
    store: {
      messages: {
        getCompactionSummary: async () => 'Previously generated LLM summary about architecture.',
        setCompactionSummary: async () => {},
      },
    } as unknown as CompactionDeps['store'],
    createCompactionAgent: undefined,
  });

  const result = await compactContextIfNeeded('s1', stubConfig, [], messages, deps);
  const compactionBlock = result.find(
    (m) => m.role === 'user' && JSON.stringify(m.content).includes('Previously generated LLM summary'),
  );
  assert.ok(compactionBlock, 'should use persisted LLM summary');
});

test('compactContextIfNeeded falls back to text extraction when compaction summary read fails', async () => {
  const longText = 'word '.repeat(200).trim();
  const messages = [
    makeUserMessage(longText),
    makeAssistantMessage(longText),
    makeUserMessage('recent'),
  ];
  const deps = createStubDeps({
    options: {
      contextCompactionMaxTokens: 400,
      contextCompactionRecentMessageCount: 1,
      contextCompactionSummaryMaxChars: 100,
    },
    store: {
      messages: {
        getCompactionSummary: async () => { throw new Error('db error'); },
        setCompactionSummary: async () => {},
      },
    } as unknown as CompactionDeps['store'],
    createCompactionAgent: undefined,
  });

  const result = await compactContextIfNeeded('s1', stubConfig, [], messages, deps);
  // Should still produce a compaction block with text extraction.
  assert.ok(
    result.some(
      (m) => m.role === 'user' && JSON.stringify(m.content).includes('Compacted earlier session history'),
    ),
  );
});

// ── estimateContentTokens ─────────────────────────────────────────────

test('estimateContentTokens handles plain string', () => {
  assert.equal(estimateContentTokens('abcdefgh'), 2);
});

test('estimateContentTokens handles non-array non-string (object)', () => {
  const obj = { foo: 'bar' };
  assert.equal(estimateContentTokens(obj), estimateTextTokens(JSON.stringify(obj)));
});

test('estimateContentTokens handles array of text items', () => {
  const content = [{ type: 'text', text: 'hello world' }];
  assert.equal(estimateContentTokens(content), estimateTextTokens('hello world'));
});

test('estimateContentTokens handles thinking items', () => {
  const content = [{ type: 'thinking', thinking: 'some thought' }];
  assert.equal(estimateContentTokens(content), estimateTextTokens('some thought'));
});

test('estimateContentTokens handles toolCall items', () => {
  const content = [{ type: 'toolCall', name: 'exec', arguments: { cmd: 'ls' } }];
  const expected = estimateTextTokens(`exec ${JSON.stringify({ cmd: 'ls' })}`);
  assert.equal(estimateContentTokens(content), expected);
});

test('estimateContentTokens returns 256 for image items', () => {
  const content = [{ type: 'image', data: 'base64data' }];
  assert.equal(estimateContentTokens(content), 256);
});

test('estimateContentTokens handles mixed content array', () => {
  const content = [
    { type: 'text', text: 'hello' },
    { type: 'image', data: 'x' },
  ];
  assert.equal(estimateContentTokens(content), estimateTextTokens('hello') + 256);
});

test('estimateContentTokens falls back to JSON.stringify for unknown items', () => {
  const content = [{ type: 'custom', value: 123 }];
  assert.equal(estimateContentTokens(content), estimateTextTokens(JSON.stringify(content[0])));
});

test('estimateContentTokens handles items without type field', () => {
  const content = [{ noType: true }];
  assert.equal(estimateContentTokens(content), estimateTextTokens(JSON.stringify(content[0])));
});

// ── truncateToolResults ───────────────────────────────────────────────

test('truncateToolResults passes through non-toolResult messages', () => {
  const messages = [makeUserMessage('hello'), makeAssistantMessage('world')];
  const result = truncateToolResults(messages, 100_000);
  assert.deepEqual(result, messages);
});

test('truncateToolResults keeps small tool results unchanged', () => {
  const messages = [makeToolResultMessage('exec', 'short output')];
  const result = truncateToolResults(messages, 100_000);
  assert.deepEqual(result, messages);
});

test('truncateToolResults truncates oversized tool results', () => {
  const bigText = 'x'.repeat(200_000);
  const messages: AgentMessage[] = [{
    role: 'toolResult',
    toolCallId: 'call-exec',
    toolName: 'exec',
    content: [{ type: 'text', text: bigText }],
    isError: false,
    timestamp: Date.now(),
  }];
  // contextWindow=1000 → maxChars = 1000 * 0.25 * 4 = 1000
  const result = truncateToolResults(messages, 1000);
  const resultText = (result[0] as any).content[0].text;
  assert.ok(resultText.length < bigText.length);
  assert.ok(resultText.includes('[truncated:'));
});

test('truncateToolResults respects TOOL_RESULT_MAX_CONTEXT_RATIO', () => {
  assert.equal(TOOL_RESULT_MAX_CONTEXT_RATIO, 0.25);
});

test('truncateToolResults handles multiple content items with budget exhaustion', () => {
  const messages: AgentMessage[] = [{
    role: 'toolResult',
    toolCallId: 'call-exec',
    toolName: 'exec',
    content: [
      { type: 'text', text: 'x'.repeat(50_000) },
      { type: 'text', text: 'second part' },
    ],
    isError: false,
    timestamp: Date.now(),
  }];
  // contextWindow=1000 → maxChars=1000, first item exceeds budget
  const result = truncateToolResults(messages, 1000);
  const content = (result[0] as any).content;
  // First item truncated, second item should be empty string (budget exhausted)
  assert.ok(content[0].text.includes('[truncated:'));
  assert.equal(content[1].text, '');
});

// ── Config helpers ────────────────────────────────────────────────────

test('getContextCompactionRecentMessageCount returns option when set', () => {
  assert.equal(getContextCompactionRecentMessageCount({ contextCompactionRecentMessageCount: 10 }), 10);
});

test('getContextCompactionRecentMessageCount returns default when unset', () => {
  assert.equal(getContextCompactionRecentMessageCount({}), DEFAULT_CONTEXT_COMPACTION_RECENT_MESSAGE_COUNT);
});

test('getContextCompactionSummaryMaxChars returns option when set', () => {
  assert.equal(getContextCompactionSummaryMaxChars({ contextCompactionSummaryMaxChars: 500 }), 500);
});

test('getContextCompactionSummaryMaxChars returns default when unset', () => {
  assert.equal(getContextCompactionSummaryMaxChars({}), DEFAULT_CONTEXT_COMPACTION_SUMMARY_MAX_CHARS);
});

test('getContextCompactionMaxTokens returns option when explicitly set', () => {
  assert.equal(getContextCompactionMaxTokens(stubConfig, { contextCompactionMaxTokens: 5000 }), 5000);
});

test('getContextCompactionMaxTokens derives from model config when not set', () => {
  const result = getContextCompactionMaxTokens(stubConfig, {});
  assert.ok(result >= 2048, 'should be at least 2048');
  assert.ok(typeof result === 'number');
});

// ── runCompactionSummaryTurn ──────────────────────────────────────────

test('runCompactionSummaryTurn returns undefined for empty messages', async () => {
  const result = await runCompactionSummaryTurn({
    sessionId: 's1',
    compactedMessages: [],
    previousCompactionSummary: undefined,
    createAgent: async () => { throw new Error('should not be called'); },
  });
  assert.equal(result, undefined);
});

test('runCompactionSummaryTurn returns undefined for messages with no text', async () => {
  // A message where summarizeMessageForCompaction returns undefined
  const result = await runCompactionSummaryTurn({
    sessionId: 's1',
    compactedMessages: [{ role: 'unknown' } as unknown as AgentMessage],
    previousCompactionSummary: undefined,
    createAgent: async () => { throw new Error('should not be called'); },
  });
  assert.equal(result, undefined);
});

test('runCompactionSummaryTurn extracts JSON summary from agent response', async () => {
  const mockAgent = {
    prompt: async () => {},
    waitForIdle: async () => {},
    state: {
      messages: [
        {
          role: 'assistant' as const,
          content: [{ type: 'text' as const, text: '{"compactionSummary":"User discussed project setup."}' }],
          ...assistantDefaults,
          timestamp: Date.now(),
        },
      ],
    },
  };

  const result = await runCompactionSummaryTurn({
    sessionId: 's1',
    compactedMessages: [makeUserMessage('setup the project'), makeAssistantMessage('done')],
    previousCompactionSummary: undefined,
    createAgent: async () => mockAgent as any,
  });
  assert.equal(result, 'User discussed project setup.');
});

test('runCompactionSummaryTurn handles plain text response (non-JSON)', async () => {
  const mockAgent = {
    prompt: async () => {},
    waitForIdle: async () => {},
    state: {
      messages: [
        {
          role: 'assistant' as const,
          content: [{ type: 'text' as const, text: 'The user set up a project and ran tests.' }],
          ...assistantDefaults,
          timestamp: Date.now(),
        },
      ],
    },
  };

  const result = await runCompactionSummaryTurn({
    sessionId: 's1',
    compactedMessages: [makeUserMessage('hello')],
    previousCompactionSummary: undefined,
    createAgent: async () => mockAgent as any,
  });
  assert.equal(result, 'The user set up a project and ran tests.');
});

test('runCompactionSummaryTurn handles code-fenced JSON response', async () => {
  const mockAgent = {
    prompt: async () => {},
    waitForIdle: async () => {},
    state: {
      messages: [
        {
          role: 'assistant' as const,
          content: [{ type: 'text' as const, text: '```json\n{"compactionSummary":"Fenced summary."}\n```' }],
          ...assistantDefaults,
          timestamp: Date.now(),
        },
      ],
    },
  };

  const result = await runCompactionSummaryTurn({
    sessionId: 's1',
    compactedMessages: [makeUserMessage('hello')],
    previousCompactionSummary: undefined,
    createAgent: async () => mockAgent as any,
  });
  assert.equal(result, 'Fenced summary.');
});

test('runCompactionSummaryTurn includes previous summary in prompt', async () => {
  let capturedPrompt = '';
  const mockAgent = {
    prompt: async (msg: AgentMessage) => {
      capturedPrompt = JSON.stringify(msg.content);
    },
    waitForIdle: async () => {},
    state: {
      messages: [
        {
          role: 'assistant' as const,
          content: [{ type: 'text' as const, text: '{"compactionSummary":"Updated."}' }],
          ...assistantDefaults,
          timestamp: Date.now(),
        },
      ],
    },
  };

  await runCompactionSummaryTurn({
    sessionId: 's1',
    compactedMessages: [makeUserMessage('hello')],
    previousCompactionSummary: 'Previous context about project.',
    createAgent: async () => mockAgent as any,
  });
  assert.ok(capturedPrompt.includes('Previous context about project.'));
});

// ── compactContextIfNeeded with LLM agent ─────────────────────────────

test('compactContextIfNeeded uses LLM summary when createCompactionAgent is provided', async () => {
  const longText = 'word '.repeat(200).trim();
  const messages = [
    makeUserMessage(longText),
    makeAssistantMessage(longText),
    makeUserMessage(longText),
    makeAssistantMessage(longText),
    makeUserMessage('recent'),
    makeAssistantMessage('reply'),
  ];

  let summaryPersisted = '';
  const mockAgent = {
    prompt: async () => {},
    waitForIdle: async () => {},
    state: {
      messages: [
        {
          role: 'assistant' as const,
          content: [{ type: 'text' as const, text: '{"compactionSummary":"LLM generated summary."}' }],
          ...assistantDefaults,
          timestamp: Date.now(),
        },
      ],
    },
  };

  const deps = createStubDeps({
    options: {
      contextCompactionMaxTokens: 800,
      contextCompactionRecentMessageCount: 2,
    },
    store: {
      messages: {
        getCompactionSummary: async () => undefined,
        setCompactionSummary: async (_scope: unknown, _sid: unknown, summary: string) => {
          summaryPersisted = summary;
        },
      },
    } as unknown as CompactionDeps['store'],
    createCompactionAgent: async () => mockAgent as any,
  });

  const result = await compactContextIfNeeded('s1', stubConfig, [], messages, deps);
  assert.ok(
    result.some((m) => m.role === 'user' && JSON.stringify(m.content).includes('LLM generated summary')),
  );
  assert.equal(summaryPersisted, 'LLM generated summary.');
});

test('compactContextIfNeeded falls back to text extraction when LLM agent throws', async () => {
  const longText = 'word '.repeat(400).trim();
  const messages = [
    makeUserMessage(longText),
    makeAssistantMessage(longText),
    makeUserMessage(longText),
    makeAssistantMessage(longText),
    makeUserMessage('recent question'),
    makeAssistantMessage('recent answer'),
  ];

  const deps = createStubDeps({
    options: {
      contextCompactionMaxTokens: 600,
      contextCompactionRecentMessageCount: 2,
    },
    createCompactionAgent: async () => { throw new Error('model unavailable'); },
  });

  const result = await compactContextIfNeeded('s1', stubConfig, [], messages, deps);
  assert.ok(result.length < messages.length, 'should compact');
  assert.ok(
    result.some((m) => m.role === 'user' && JSON.stringify(m.content).includes('Compacted earlier session history')),
  );
});

test('compactContextIfNeeded shrink-expand finds optimal retain count', async () => {
  const longText = 'word '.repeat(300).trim();
  const messages = [
    makeUserMessage(longText),
    makeAssistantMessage(longText),
    makeUserMessage(longText),
    makeAssistantMessage(longText),
    makeUserMessage(longText),
    makeAssistantMessage(longText),
    makeUserMessage('final'),
    makeAssistantMessage('reply'),
  ];

  const deps = createStubDeps({
    options: {
      contextCompactionMaxTokens: 600,
      contextCompactionRecentMessageCount: 8,
    },
  });

  const result = await compactContextIfNeeded('s1', stubConfig, [], messages, deps);
  assert.ok(result.length < messages.length, 'should compact some messages');
  assert.ok(result.some((m) => m.role === 'assistant' && JSON.stringify(m.content).includes('reply')));
});

test('compactContextIfNeeded returns original when compaction does not reduce tokens', async () => {
  // Only 2 short messages — compaction overhead would make it bigger
  const messages = [
    makeUserMessage('hi'),
    makeAssistantMessage('hello'),
  ];

  const deps = createStubDeps({
    options: {
      contextCompactionMaxTokens: 10,
      contextCompactionRecentMessageCount: 1,
    },
  });

  const result = await compactContextIfNeeded('s1', stubConfig, [], messages, deps);
  // When compacted >= original, should return original combined
  assert.ok(result.length >= 2);
});

// ── estimateFixedOverheadTokens ───────────────────────────────────────

test('estimateFixedOverheadTokens returns 0 for empty input', () => {
  assert.equal(estimateFixedOverheadTokens({}), 0);
});

test('estimateFixedOverheadTokens counts system prompt only', () => {
  const tokens = estimateFixedOverheadTokens({ systemPrompt: 'a'.repeat(400) });
  assert.equal(tokens, estimateTextTokens('a'.repeat(400)));
});

test('estimateFixedOverheadTokens counts each tool independently', () => {
  const tools = [
    { name: 'echo', description: 'echoes back', parameters: { type: 'object' } },
    { name: 'read', description: 'read file', parameters: { type: 'object' } },
  ];
  const tokens = estimateFixedOverheadTokens({ tools });
  const expected = tools.reduce((sum, t) => sum + estimateTextTokens(JSON.stringify(t)), 0);
  assert.equal(tokens, expected);
});

test('estimateFixedOverheadTokens tolerates circular tool refs', () => {
  const circular: Record<string, unknown> = { name: 'self' };
  circular.self = circular;
  // Should fall back to the 256-token placeholder rather than throwing.
  const tokens = estimateFixedOverheadTokens({ tools: [circular] });
  assert.equal(tokens, 256);
});

test('estimateFixedOverheadTokens sums prompt and tools', () => {
  const tools = [{ name: 't' }];
  const prompt = 'hello world';
  const tokens = estimateFixedOverheadTokens({ systemPrompt: prompt, tools });
  assert.equal(
    tokens,
    estimateTextTokens(prompt) + estimateTextTokens(JSON.stringify(tools[0])),
  );
});

// ── fixedOverheadTokens compaction trigger ────────────────────────────

test('compactContextIfNeeded compacts when overhead pushes payload past budget', async () => {
  // Messages alone fit comfortably under a 1500-token budget, but
  // overhead pushes the real payload over — must still compact.
  const messages = [
    makeUserMessage('word '.repeat(80).trim()),   // ~100 tokens
    makeAssistantMessage('word '.repeat(80).trim()),
    makeUserMessage('word '.repeat(80).trim()),
    makeAssistantMessage('word '.repeat(80).trim()),
    makeUserMessage('recent question'),
    makeAssistantMessage('recent answer'),
  ];
  const messageTokens = estimateAgentMessagesTokens(messages);
  assert.ok(messageTokens < 1500, `precondition: messages should fit under budget; got ${messageTokens}`);

  const deps = createStubDeps({
    options: {
      contextCompactionMaxTokens: 1500,
      contextCompactionRecentMessageCount: 2,
      // 2000 tokens of overhead — easily exceeds the 1500 budget.
      fixedOverheadTokens: 2000,
    },
  });

  const result = await compactContextIfNeeded('s1', stubConfig, [], messages, deps);
  assert.ok(result.length < messages.length, 'overhead alone must trigger compaction');
});

test('compactContextIfNeeded skips compaction when overhead absent and messages fit', async () => {
  const messages = [
    makeUserMessage('word '.repeat(80).trim()),
    makeAssistantMessage('word '.repeat(80).trim()),
  ];
  const deps = createStubDeps({
    options: {
      contextCompactionMaxTokens: 1500,
      contextCompactionRecentMessageCount: 2,
    },
  });
  const result = await compactContextIfNeeded('s1', stubConfig, [], messages, deps);
  assert.equal(result.length, messages.length);
});

// ── message-count secondary trigger ───────────────────────────────────

test('getContextCompactionMaxMessages returns option when set', () => {
  assert.equal(getContextCompactionMaxMessages({ contextCompactionMaxMessages: 5 }), 5);
});

test('getContextCompactionMaxMessages returns default when unset', () => {
  assert.equal(getContextCompactionMaxMessages({}), DEFAULT_CONTEXT_COMPACTION_MAX_MESSAGES);
});

test('compactContextIfNeeded compacts when message count exceeds threshold even under budget', async () => {
  // 12 tiny messages — well under any reasonable token budget, but
  // pushing past a 5-message count threshold.
  const messages: AgentMessage[] = [];
  for (let i = 0; i < 12; i += 1) {
    messages.push(makeUserMessage(`q${i}`));
    messages.push(makeAssistantMessage(`a${i}`));
  }
  const totalTokens = estimateAgentMessagesTokens(messages);
  assert.ok(totalTokens < 100_000, 'precondition: well under token budget');

  const deps = createStubDeps({
    options: {
      contextCompactionMaxTokens: 100_000,
      contextCompactionRecentMessageCount: 3,
      contextCompactionMaxMessages: 5,
    },
  });

  const result = await compactContextIfNeeded('s1', stubConfig, [], messages, deps);
  assert.ok(result.length < messages.length, 'message-count trigger must compact');
});

test('compactContextIfNeeded enforces count cap when recentMessageCount > maxMessages', async () => {
  // Initial retainCount (10) starts ABOVE the count cap (5). Tokens fit
  // under budget so the token-only shrink loop would never enter — the
  // candidate must still come back at or under the cap.
  const messages: AgentMessage[] = [];
  for (let i = 0; i < 14; i += 1) {
    messages.push(makeUserMessage(`q${i}`));
    messages.push(makeAssistantMessage(`a${i}`));
  }
  const totalTokens = estimateAgentMessagesTokens(messages);
  assert.ok(totalTokens < 100_000, 'precondition: well under token budget');

  const deps = createStubDeps({
    options: {
      contextCompactionMaxTokens: 100_000,
      contextCompactionRecentMessageCount: 10,
      contextCompactionMaxMessages: 5,
    },
  });

  const result = await compactContextIfNeeded('s1', stubConfig, [], messages, deps);
  assert.ok(
    result.length <= 5 + 1, // +1 leeway for a leading compaction summary block
    `result kept ${result.length} retained messages, expected ≤ 6 including summary`,
  );
});

// ── truncateToolResults absolute cap ──────────────────────────────────

test('TOOL_RESULT_MAX_CHARS_CAP caps inline tool result regardless of context window', () => {
  // Even with a huge context window where ratio*4 would allow 256K
  // chars, the absolute cap kicks in.
  const text = 'x'.repeat(50_000);
  const messages: AgentMessage[] = [{
    role: 'toolResult',
    toolCallId: 'call-doc',
    toolName: 'doc_read',
    content: [{ type: 'text', text }],
    isError: false,
    timestamp: Date.now(),
  }];
  const result = truncateToolResults(messages, 1_000_000);
  const resultText = (result[0] as { content: Array<{ text: string }> }).content[0]!.text;
  assert.ok(resultText.length <= TOOL_RESULT_MAX_CHARS_CAP + 200, // +marker overhead
    `result kept ${resultText.length} chars, expected ≤ ~${TOOL_RESULT_MAX_CHARS_CAP}`);
  assert.ok(resultText.includes('[truncated:'));
});
