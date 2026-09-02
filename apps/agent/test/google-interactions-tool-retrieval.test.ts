import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Context, Message, Model } from '@mariozechner/pi-ai';

import {
  buildInteractionsRequest,
  collectUnlockedToolNames,
  createAmikoToolRetrievalToolset,
  GOOGLE_INTERACTIONS_API,
  isToolRetrievalModel,
  mapMessagesToSteps,
  parseInteractionSteps,
  TOOL_SEARCH_NAME,
  withGoogleInteractionsToolRetrieval,
} from '../src/providers/google-interactions-tool-retrieval.js';

const MODEL = {
  id: 'gemini-flash-tool-retrieval',
  name: 'Gemini Flash (Tool Retrieval EAP)',
  api: GOOGLE_INTERACTIONS_API,
  provider: 'google',
  baseUrl: 'https://interactions.example.test',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1000000,
  maxTokens: 8192,
} as unknown as Model<never>;

const userMessage = (text: string): Message => ({ role: 'user', content: text, timestamp: 1 });

const toolSearchResult = (declaredNames: string[]): Message => ({
  role: 'toolResult',
  toolCallId: 'call_1',
  toolName: TOOL_SEARCH_NAME,
  content: [{
    type: 'text',
    text: JSON.stringify({
      tools: declaredNames.map((name) => ({ type: 'function', name, description: 'x', parameters: { type: 'object', properties: {} } })),
    }),
  }],
  isError: false,
  timestamp: 3,
});

test('isToolRetrievalModel matches only the google-interactions api', () => {
  assert.ok(isToolRetrievalModel({ api: GOOGLE_INTERACTIONS_API }));
  assert.ok(!isToolRetrievalModel({ api: 'google-generative-ai' }));
  assert.ok(!isToolRetrievalModel({}));
});

test('turn 1 request advertises ONLY the client tool_search tool', () => {
  const request = buildInteractionsRequest(MODEL, {
    systemPrompt: 'You are a helpful hermit.',
    messages: [userMessage('what is my credits balance?')],
  } as Context);
  assert.equal(request.model, 'gemini-flash-tool-retrieval');
  assert.equal(request.store, false);
  assert.equal(request.system_instruction, 'You are a helpful hermit.');
  const tools = request.tools as Array<Record<string, unknown>>;
  assert.equal(tools.length, 1);
  assert.equal(tools[0]!.type, 'tool_search');
  assert.equal(tools[0]!.execution, 'client');
  assert.equal(tools[0]!.name, TOOL_SEARCH_NAME);
});

test('after a tool_search result, searched declarations are advertised (and only those)', () => {
  const messages: Message[] = [
    userMessage('credits balance and version please'),
    {
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'call_1', name: TOOL_SEARCH_NAME, arguments: { query: 'credits' } }],
      api: GOOGLE_INTERACTIONS_API as never,
      provider: 'google' as never,
      model: 'gemini-flash-tool-retrieval',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: 'toolUse',
      timestamp: 2,
    },
    toolSearchResult(['amiko_credits_balance', 'amiko_version', 'not_in_catalog']),
  ];
  assert.deepEqual(
    collectUnlockedToolNames(messages).sort(),
    ['amiko_credits_balance', 'amiko_version'],
  );
  const request = buildInteractionsRequest(MODEL, { messages } as Context);
  const tools = request.tools as Array<Record<string, unknown>>;
  assert.equal(tools[0]!.type, 'tool_search');
  const functionNames = tools.slice(1).map((t) => t.name).sort();
  assert.deepEqual(functionNames, ['amiko_credits_balance', 'amiko_version']);
  assert.ok(tools.slice(1).every((t) => t.type === 'function'));
});

test('mapMessagesToSteps round-trips history with thought signatures', () => {
  const messages: Message[] = [
    userMessage('hi'),
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'pondering', thinkingSignature: 'sig-thought' },
        { type: 'toolCall', id: 'call_9', name: 'amiko_credits_balance', arguments: {}, thoughtSignature: 'sig-call' },
      ],
      api: GOOGLE_INTERACTIONS_API as never,
      provider: 'google' as never,
      model: 'gemini-flash-tool-retrieval',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: 'toolUse',
      timestamp: 2,
    },
    {
      role: 'toolResult',
      toolCallId: 'call_9',
      toolName: 'amiko_credits_balance',
      content: [{ type: 'text', text: 'Balance: 120,000 credits' }],
      isError: false,
      timestamp: 3,
    },
  ];
  const steps = mapMessagesToSteps(messages);
  assert.deepEqual(steps.map((s) => s.type), ['user_input', 'thought', 'function_call', 'function_result']);
  assert.equal((steps[1] as { signature?: string }).signature, 'sig-thought');
  const call = steps[2] as { id: string; name: string; signature?: string };
  assert.equal(call.id, 'call_9');
  assert.equal(call.signature, 'sig-call');
  const result = steps[3] as { call_id: string; result: Array<{ text: string }> };
  assert.equal(result.call_id, 'call_9');
  assert.equal(result.result[0]!.text, 'Balance: 120,000 credits');
});

test('parseInteractionSteps maps steps to an AssistantMessage with signatures', () => {
  const message = parseInteractionSteps({
    id: 'int_123',
    steps: [
      { type: 'thought', summary: 'let me search', signature: 'sig-1' },
      { type: 'function_call', id: 'call_2', name: TOOL_SEARCH_NAME, arguments: { query: 'credits' }, signature: 'sig-2' },
    ],
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
  }, { provider: 'google', model: 'gemini-flash-tool-retrieval' });
  assert.equal(message.stopReason, 'toolUse');
  assert.equal(message.responseId, 'int_123');
  assert.equal(message.usage.totalTokens, 15);
  const [thought, call] = message.content;
  assert.equal(thought!.type, 'thinking');
  assert.equal((thought as { thinkingSignature?: string }).thinkingSignature, 'sig-1');
  assert.equal(call!.type, 'toolCall');
  assert.equal((call as { thoughtSignature?: string }).thoughtSignature, 'sig-2');
});

test('toolset: tool_search returns declarations; catalog tools are registered', async () => {
  const toolset = createAmikoToolRetrievalToolset();
  const toolSearch = toolset.tools.find((t) => t.name === TOOL_SEARCH_NAME)!;
  const result = await toolSearch.execute('call_x', { query: 'credits balance' });
  const parsed = JSON.parse((result.content[0] as { text: string }).text) as { tools: Array<{ name: string }> };
  assert.ok(parsed.tools.some((t) => t.name === 'amiko_credits_balance'));
  assert.ok(toolset.tools.some((t) => t.name === 'amiko_credits_balance'));
  assert.ok(toolset.tools.some((t) => t.name === 'amiko_version'));
  // Mutating tools are owner-gated.
  const send = toolset.tools.find((t) => t.name === 'amiko_chat_send')!;
  assert.deepEqual(send.policy?.defaultGrants, [{ type: 'role', value: 'owner' }]);
});

test('stream adapter: passes non-TR models through and serves TR models over Interactions', async () => {
  let passthroughCalled = false;
  const base = (() => {
    passthroughCalled = true;
    return undefined as never;
  }) as never;

  const fetchCalls: Array<{ url: string; body: Record<string, unknown>; headers: Record<string, string> }> = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    fetchCalls.push({
      url: String(url),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      headers: init?.headers as Record<string, string>,
    });
    return new Response(JSON.stringify({
      id: 'int_1',
      status: 'completed',
      steps: [
        { type: 'function_call', id: 'call_1', name: TOOL_SEARCH_NAME, arguments: { query: 'credits' } },
      ],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;

  const streamFn = withGoogleInteractionsToolRetrieval(base, { fetchImpl });

  // Non-TR model → delegates to the wrapped function.
  streamFn({ api: 'openai-completions' } as never, { messages: [] } as never, {});
  assert.ok(passthroughCalled);

  // TR model → Interactions request + parsed tool call.
  const stream = await streamFn(MODEL as never, {
    systemPrompt: 'sys',
    messages: [userMessage('balance?')],
  } as never, { apiKey: 'test-key' });
  const message = await stream.result();
  assert.equal(message.stopReason, 'toolUse');
  assert.equal(message.content[0]!.type, 'toolCall');

  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0]!.url, 'https://interactions.example.test/v1beta/interactions');
  assert.equal(fetchCalls[0]!.headers['x-goog-api-key'], 'test-key');
  const tools = fetchCalls[0]!.body.tools as Array<Record<string, unknown>>;
  assert.equal(tools.length, 1);
  assert.equal(tools[0]!.type, 'tool_search');
});

test('stream adapter: HTTP errors and missing endpoint become error messages, never throws', async () => {
  const failingFetch = (async () =>
    new Response('{"error": "bad"}', { status: 400 })) as typeof fetch;
  const streamFn = withGoogleInteractionsToolRetrieval(((() => {
    throw new Error('must not delegate');
  }) as never), { fetchImpl: failingFetch });

  const stream = await streamFn(MODEL as never, { messages: [userMessage('x')] } as never, { apiKey: 'k' });
  const message = await stream.result();
  assert.equal(message.stopReason, 'error');
  assert.match(message.errorMessage ?? '', /Interactions API error 400/);

  // No baseUrl anywhere → explicit configuration error.
  const bareModel = { ...(MODEL as object), baseUrl: undefined } as never;
  const prevEnv = process.env.GOOGLE_INTERACTIONS_BASE_URL;
  delete process.env.GOOGLE_INTERACTIONS_BASE_URL;
  try {
    const s2 = await streamFn(bareModel, { messages: [userMessage('x')] } as never, { apiKey: 'k' });
    const m2 = await s2.result();
    assert.equal(m2.stopReason, 'error');
    assert.match(m2.errorMessage ?? '', /No Interactions endpoint configured/);
  } finally {
    if (prevEnv !== undefined) process.env.GOOGLE_INTERACTIONS_BASE_URL = prevEnv;
  }
});

test('stream adapter: full endpoint URLs ending in /interactions are used verbatim', async () => {
  let seenUrl = '';
  const fetchImpl = (async (url: string | URL) => {
    seenUrl = String(url);
    return new Response(JSON.stringify({ id: 'i', status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text: 'hi' }] }] }), { status: 200 });
  }) as typeof fetch;
  const streamFn = withGoogleInteractionsToolRetrieval(((() => undefined) as never), { fetchImpl });
  const model = { ...(MODEL as object), baseUrl: 'https://eap.example.test/custom/interactions' } as never;
  const stream = await streamFn(model, { messages: [userMessage('x')] } as never, { apiKey: 'k' });
  const message = await stream.result();
  assert.equal(seenUrl, 'https://eap.example.test/custom/interactions');
  assert.equal(message.stopReason, 'stop');
  assert.deepEqual(message.content, [{ type: 'text', text: 'hi' }]);
});
