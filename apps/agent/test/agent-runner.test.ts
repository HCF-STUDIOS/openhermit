import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';

import type { StreamFn } from '@mariozechner/pi-agent-core';
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
  type ToolCall,
  type Usage,
} from '@mariozechner/pi-ai';

import type { SessionAttachment } from '@openhermit/protocol';

import { AgentRunner } from '../src/agent-runner.js';
import type { LangfuseClientLike } from '../src/langfuse.js';
import { DbAttachmentStore, DbInternalStateStore, LocalAttachmentStorage } from '@openhermit/store';

// Each test now uses a unique agentId from the security fixture.
import { createSecurityFixture } from './helpers.js';

const zeroUsage: Usage = {
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

const createAssistantMessage = (
  content: AssistantMessage['content'],
  stopReason: AssistantMessage['stopReason'],
): AssistantMessage => ({
  role: 'assistant',
  content,
  api: 'anthropic-messages',
  provider: 'anthropic',
  model: 'claude-opus-4-5',
  usage: zeroUsage,
  stopReason,
  timestamp: Date.now(),
});

const createTextResponseStream = (text: string) => {
  const stream = createAssistantMessageEventStream();
  const partial = createAssistantMessage(
    [
      {
        type: 'text',
        text,
      },
    ],
    'stop',
  );

  stream.push({
    type: 'start',
    partial: createAssistantMessage([], 'stop'),
  });
  stream.push({
    type: 'text_start',
    contentIndex: 0,
    partial,
  });
  stream.push({
    type: 'text_delta',
    contentIndex: 0,
    delta: text,
    partial,
  });
  stream.push({
    type: 'text_end',
    contentIndex: 0,
    content: text,
    partial,
  });
  stream.push({
    type: 'done',
    reason: 'stop',
    message: partial,
  });

  return stream;
};

const createToolCallResponseStream = (
  toolCall: ToolCall,
  options?: { prefixText?: string | undefined },
) => {
  const stream = createAssistantMessageEventStream();
  const content: AssistantMessage['content'] = [];

  if (options?.prefixText !== undefined) {
    content.push({
      type: 'text',
      text: options.prefixText,
    });
  }

  content.push(toolCall);

  const message = createAssistantMessage(content, 'toolUse');

  stream.push({
    type: 'start',
    partial: createAssistantMessage([], 'toolUse'),
  });
  stream.push({
    type: 'toolcall_start',
    contentIndex: 0,
    partial: message,
  });
  stream.push({
    type: 'toolcall_end',
    contentIndex: 0,
    toolCall,
    partial: message,
  });
  stream.push({
    type: 'done',
    reason: 'toolUse',
    message,
  });

  return stream;
};

/**
 * Stream where the model emits only thinking and then claims `toolUse` as the
 * stop reason — but never produces an actual `toolCall` block. Reproduces the
 * moonshotai/kimi-k2.6-via-OpenRouter pattern where pi-ai has nothing to
 * dispatch and the turn would otherwise persist with empty content and never
 * publish a text_final event.
 */
const createThinkingOnlyToolUseStream = (thinking: string) => {
  const stream = createAssistantMessageEventStream();
  const message = createAssistantMessage(
    [
      {
        type: 'thinking',
        thinking,
      },
    ],
    'toolUse',
  );

  stream.push({
    type: 'start',
    partial: createAssistantMessage([], 'toolUse'),
  });
  stream.push({
    type: 'thinking_start',
    contentIndex: 0,
    partial: message,
  });
  stream.push({
    type: 'thinking_delta',
    contentIndex: 0,
    delta: thinking,
    partial: message,
  });
  stream.push({
    type: 'thinking_end',
    contentIndex: 0,
    content: thinking,
    partial: message,
  });
  stream.push({
    type: 'done',
    reason: 'toolUse',
    message,
  });

  return stream;
};

const createSequentialStreamFn = (
  responders: Array<(context: Context) => ReturnType<typeof createAssistantMessageEventStream>>,
): StreamFn => {
  let index = 0;

  return async (_model, context) => {
    const responder = responders[index];
    index += 1;

    if (!responder) {
      throw new Error(`Unexpected stream call #${index}`);
    }

    return responder(context);
  };
};

const readSessionLog = async (
  runner: AgentRunner,
  sessionId: string,
): Promise<Array<Record<string, unknown>>> =>
  (await runner.listSessionLogEntries(sessionId)) as Array<Record<string, unknown>>;

class FakeLangfuseGeneration {
  readonly ended: Array<Record<string, unknown>> = [];

  end(body: Record<string, unknown>) {
    this.ended.push(body);
    return this;
  }
}

class FakeLangfuseTrace {
  readonly generations: Array<{
    body: Record<string, unknown>;
    client: FakeLangfuseGeneration;
  }> = [];

  readonly updates: Array<Record<string, unknown>> = [];

  generation(body: Record<string, unknown>) {
    const client = new FakeLangfuseGeneration();
    this.generations.push({ body, client });
    return client;
  }

  update(body: Record<string, unknown>) {
    this.updates.push(body);
    return this;
  }
}

class FakeLangfuseClient implements LangfuseClientLike {
  readonly traces: Array<{
    body: Record<string, unknown>;
    client: FakeLangfuseTrace;
  }> = [];

  async flushAsync(): Promise<void> {}

  trace(body: Record<string, unknown>) {
    const client = new FakeLangfuseTrace();
    this.traces.push({ body, client });
    return client;
  }
}

test('AgentRunner publishes SSE text events and writes minimal logs', async (t) => {
  const { workspace, security } = await createSecurityFixture(t, {
    secrets: {
      ANTHROPIC_API_KEY: 'test-anthropic-key',
    },
  });
  await security.load();

  const runner = await AgentRunner.create({
    workspace,
    security,
    streamFn: createSequentialStreamFn([
      () => createTextResponseStream('hello from agent runner'),
    ]),
  });

  await runner.openSession({
    sessionId: 'cli:test-session',
    source: {
      kind: 'cli',
      interactive: true,
    },
  });
  await runner.postMessage('cli:test-session', {
    messageId: 'msg-1',
    text: 'hello',
  });
  await runner.waitForSessionIdle('cli:test-session');

  const backlog = runner.events.getBacklog('cli:test-session');

  assert.ok(
    backlog.some(
      (entry) =>
        entry.event.type === 'text_delta' &&
        entry.event.text === 'hello from agent runner',
    ),
  );
  assert.ok(
    backlog.some(
      (entry) =>
        entry.event.type === 'text_final' &&
        entry.event.text === 'hello from agent runner',
    ),
  );

  const sessionEntries = await readSessionLog(runner, 'cli:test-session');
  assert.ok(
    sessionEntries.some((entry) => entry.type === 'session_started'),
  );
  assert.ok(
    sessionEntries.some(
      (entry) => entry.role === 'user' && entry.content === 'hello',
    ),
  );
  assert.ok(
    sessionEntries.some(
      (entry) =>
        entry.role === 'assistant' &&
        entry.content === 'hello from agent runner',
    ),
  );
});

test('AgentRunner builds dynamic system prompt based on available tools', async (t) => {
  const { workspace, security } = await createSecurityFixture(t, {
    secrets: {
      ANTHROPIC_API_KEY: 'test-anthropic-key',
    },
  });
  await security.load();

  let capturedSystemPrompt = '';
  const runner = await AgentRunner.create({
    workspace,
    security,
    streamFn: createSequentialStreamFn([
      (context) => {
        capturedSystemPrompt = context.systemPrompt ?? '';
        return createTextResponseStream('captured');
      },
    ]),
  });

  await runner.openSession({
    sessionId: 'cli:prompt-guidance',
    source: {
      kind: 'cli',
      interactive: true,
    },
  });
  await runner.postMessage('cli:prompt-guidance', {
    text: 'Run a script in a container.',
  });
  await runner.waitForSessionIdle('cli:prompt-guidance');

  // Preamble always present
  assert.match(capturedSystemPrompt, /You are an AI agent with your own persistent identity/);
  assert.match(capturedSystemPrompt, /Your primary job is to help your owner and authorized users accomplish real tasks safely and effectively/);

  // Instruction section present
  assert.match(capturedSystemPrompt, /## Instructions/);

  // Principles section present
  assert.match(capturedSystemPrompt, /Built-in tools are execution primitives, not product goals/);

  // Container section absent (container tools are currently disabled)
  assert.doesNotMatch(capturedSystemPrompt, /Service Containers/);

  // Exec section present (local backend is always available as fallback)
  assert.match(capturedSystemPrompt, /### Execution/);

  // Memory section present (memoryProvider is always provided)
  assert.match(capturedSystemPrompt, /memory_recall/);
  assert.match(capturedSystemPrompt, /ID namespacing/);
});

test('AgentRunner injects session working memory but not long-term memory', async (t) => {
  const { workspace, security, agentId } = await createSecurityFixture(t, {
    secrets: {
      ANTHROPIC_API_KEY: 'test-anthropic-key',
    },
  });
  await security.load();

  let capturedMessages: Context['messages'] = [];
  const runner = await AgentRunner.create({
    workspace,
    security,
    streamFn: createSequentialStreamFn([
      (context) => {
        capturedMessages = context.messages;
        return createTextResponseStream('captured');
      },
    ]),
  });

  await runner.openSession({
    sessionId: 'cli:working-context',
    source: {
      kind: 'cli',
      interactive: true,
    },
  });
  const store = await DbInternalStateStore.open();
  t.after(() => store.close());
  const scope = { agentId };
  await store.messages.setSessionWorkingMemory(
    scope,
    'cli:working-context',
    '# Session Working Memory\nsession local context\n',
    '2026-03-13T00:00:00.000Z',
  );
  await store.memories.add(
    scope,
    { id: 'project-plan', content: 'stable project knowledge' },
  );
  await runner.postMessage('cli:working-context', {
    text: 'use memory',
  });
  await runner.waitForSessionIdle('cli:working-context');

  // Session working memory is injected as context.
  assert.equal(capturedMessages[0]?.role, 'user');
  assert.match(
    JSON.stringify(capturedMessages[0]?.content ?? ''),
    /Session-local working memory/,
  );
  // Long-term memory is NOT auto-injected; the agent uses memory_recall instead.
  const allContent = JSON.stringify(capturedMessages);
  assert.ok(!allContent.includes('Long-term memory'));
});

test('AgentRunner compacts older context when the estimated prompt budget is exceeded', async (t) => {
  const { workspace, security } = await createSecurityFixture(t, {
    secrets: {
      ANTHROPIC_API_KEY: 'test-anthropic-key',
    },
  });
  await security.load();

  const longUserA = 'alpha '.repeat(80).trim();
  const longAssistantA = 'response-alpha '.repeat(80).trim();
  const longUserB = 'beta '.repeat(80).trim();
  const longAssistantB = 'response-beta '.repeat(80).trim();
  let capturedMessages: Context['messages'] = [];
  const runner = await AgentRunner.create({
    workspace,
    security,
    contextCompactionMaxTokens: 180,
    contextCompactionRecentMessageCount: 2,
    contextCompactionSummaryMaxChars: 800,
    streamFn: createSequentialStreamFn([
      () => createTextResponseStream(longAssistantA),
      () => createTextResponseStream(longAssistantB),
      (context) => {
        capturedMessages = context.messages;
        return createTextResponseStream('final reply');
      },
    ]),
  });

  await runner.openSession({
    sessionId: 'cli:compaction-session',
    source: {
      kind: 'cli',
      interactive: true,
    },
  });
  await runner.postMessage('cli:compaction-session', {
    text: longUserA,
  });
  await runner.waitForSessionIdle('cli:compaction-session');
  await runner.postMessage('cli:compaction-session', {
    text: longUserB,
  });
  await runner.waitForSessionIdle('cli:compaction-session');
  await runner.postMessage('cli:compaction-session', {
    text: 'gamma request',
  });
  await runner.waitForSessionIdle('cli:compaction-session');

  assert.ok(
    capturedMessages.some(
      (message) =>
        message.role === 'user' &&
        JSON.stringify(message.content).includes('Context compaction summary'),
    ),
  );
  assert.ok(
    capturedMessages.some(
      (message) =>
        message.role === 'user' &&
        JSON.stringify(message.content).includes('gamma request'),
    ),
  );
});

test('AgentRunner retains the assistant tool call when compaction keeps a trailing tool result', async (t) => {
  const { workspace, security } = await createSecurityFixture(t, {
    secrets: {
      ANTHROPIC_API_KEY: 'test-anthropic-key',
    },
  });
  await security.load();
  await workspace.writeFile('files/fact.txt', '42');

  let capturedMessages: Context['messages'] = [];
  const runner = await AgentRunner.create({
    workspace,
    security,
    contextCompactionMaxTokens: 120,
    contextCompactionRecentMessageCount: 1,
    contextCompactionSummaryMaxChars: 400,
    streamFn: createSequentialStreamFn([
      () => createTextResponseStream('alpha response '.repeat(60).trim()),
      () =>
        createToolCallResponseStream({
          type: 'toolCall',
          id: 'call-read-file',
          name: 'read_file',
          arguments: {
            path: 'files/fact.txt',
          },
        }),
      (context) => {
        capturedMessages = context.messages;
        return createTextResponseStream('final reply');
      },
    ]),
  });

  await runner.openSession({
    sessionId: 'cli:compaction-tool-session',
    source: {
      kind: 'cli',
      interactive: true,
    },
  });
  await runner.postMessage('cli:compaction-tool-session', {
    text: 'alpha '.repeat(60).trim(),
  });
  await runner.waitForSessionIdle('cli:compaction-tool-session');
  await runner.postMessage('cli:compaction-tool-session', {
    text: 'Read the fact file.',
  });
  await runner.waitForSessionIdle('cli:compaction-tool-session');

  const retainedToolCall = capturedMessages.find(
    (message) =>
      message.role === 'assistant'
      && message.content.some((item) => item.type === 'toolCall' && item.name === 'read_file'),
  );
  const retainedToolResult = capturedMessages.find(
    (message) =>
      message.role === 'toolResult' && message.toolName === 'read_file',
  );

  assert.ok(retainedToolCall);
  assert.ok(retainedToolResult);
  assert.ok(
    capturedMessages.findIndex((message) => message === retainedToolCall)
      < capturedMessages.findIndex((message) => message === retainedToolResult),
  );
});

test('AgentRunner executes built-in tools through pi-agent-core', async (t) => {
  const { workspace, security, agentId } = await createSecurityFixture(t, {
    secrets: {
      ANTHROPIC_API_KEY: 'test-anthropic-key',
    },
  });
  await security.load();

  const store = await DbInternalStateStore.open();
  t.after(() => store.close());
  await store.memories.add({ agentId }, { id: 'fact', content: 'The answer is 42.' });

  const runner = await AgentRunner.create({
    workspace,
    security,
    streamFn: createSequentialStreamFn([
      () =>
        createToolCallResponseStream({
          type: 'toolCall',
          id: 'call-memory-get',
          name: 'memory_get',
          arguments: {
            key: 'fact',
          },
        }),
      () => createTextResponseStream('The fact is 42.'),
    ]),
  });

  await runner.openSession({
    sessionId: 'cli:tool-session',
    source: {
      kind: 'cli',
      interactive: true,
    },
  });
  await runner.postMessage('cli:tool-session', {
    text: 'What is the fact?',
  });
  await runner.waitForSessionIdle('cli:tool-session');

  const backlog = runner.events.getBacklog('cli:tool-session');

  assert.ok(
    backlog.some(
      (entry) =>
        entry.event.type === 'tool_call' &&
        entry.event.tool === 'memory_get' &&
        'args' in entry.event &&
        JSON.stringify(entry.event.args) === JSON.stringify({ key: 'fact' }),
      ),
  );
  assert.ok(
    backlog.some(
      (entry) =>
        entry.event.type === 'tool_result' &&
        entry.event.tool === 'memory_get' &&
        entry.event.isError === false &&
        typeof entry.event.text === 'string' &&
        entry.event.text.includes('42'),
    ),
  );
  assert.ok(
    backlog.some(
      (entry) =>
        entry.event.type === 'text_final' &&
        entry.event.text === 'The fact is 42.',
    ),
  );

  const sessionEntries = await readSessionLog(runner, 'cli:tool-session');

  assert.ok(
    sessionEntries.some(
      (entry) =>
        entry.role === 'tool_call' &&
        entry.type === 'tool_call' &&
        entry.name === 'memory_get',
    ),
  );
  assert.ok(
    sessionEntries.some(
      (entry) =>
        entry.role === 'tool_result' &&
        typeof entry.content === 'string' &&
        entry.content.includes('42'),
    ),
  );
});

test('AgentRunner ignores whitespace-only assistant messages emitted before tool use', async (t) => {
  const { workspace, security } = await createSecurityFixture(t, {
    secrets: {
      ANTHROPIC_API_KEY: 'test-anthropic-key',
    },
  });
  await security.load();
  await workspace.writeFile('files/fact.txt', '42');

  const runner = await AgentRunner.create({
    workspace,
    security,
    streamFn: createSequentialStreamFn([
      () =>
        createToolCallResponseStream({
          type: 'toolCall',
          id: 'call-read-file',
          name: 'read_file',
          arguments: {
            path: 'files/fact.txt',
          },
        }, { prefixText: ' ' }),
      () => createTextResponseStream('The fact is 42.'),
    ]),
  });

  await runner.openSession({
    sessionId: 'cli:tool-whitespace-session',
    source: {
      kind: 'cli',
      interactive: true,
    },
  });
  await runner.postMessage('cli:tool-whitespace-session', {
    text: 'Read the fact file.',
  });
  await runner.waitForSessionIdle('cli:tool-whitespace-session');

  const backlog = runner.events.getBacklog('cli:tool-whitespace-session');
  const eventTypes = backlog.map((entry) => entry.event.type);
  const toolResultIndex = eventTypes.indexOf('tool_result');
  const finalTextIndex = eventTypes.lastIndexOf('text_final');

  assert.notEqual(toolResultIndex, -1);
  assert.notEqual(finalTextIndex, -1);
  assert.ok(toolResultIndex < finalTextIndex);
  assert.equal(
    backlog.filter((entry) => entry.event.type === 'text_final').length,
    1,
  );

  const sessionEntries = await readSessionLog(runner, 'cli:tool-whitespace-session');
  const assistantEntries = sessionEntries.filter((entry) => entry.role === 'assistant');

  assert.equal(assistantEntries.length, 1);
  assert.equal(assistantEntries[0]?.content, 'The fact is 42.');

  const history = await runner.listSessionMessages('cli:tool-whitespace-session');
  const assistantHistory = history.filter((entry) => entry.role === 'assistant');

  assert.equal(assistantHistory.length, 1);
  assert.equal(assistantHistory[0]?.content, 'The fact is 42.');
});

test('AgentRunner promotes thinking to text when stopReason=toolUse but no tool_use blocks are emitted', async (t) => {
  // Regression: moonshotai/kimi-k2.6 via OpenRouter has been observed to set
  // stopReason="toolUse" while emitting only a thinking block and no actual
  // toolCall blocks. pi-ai's agent loop has nothing to dispatch and exits, so
  // without the rescue the runner would persist content="" and the channel
  // adapter would never see a text_final — looking like an interrupted reply.
  const { workspace, security } = await createSecurityFixture(t, {
    secrets: {
      ANTHROPIC_API_KEY: 'test-anthropic-key',
    },
  });
  await security.load();

  const runner = await AgentRunner.create({
    workspace,
    security,
    streamFn: createSequentialStreamFn([
      () =>
        createThinkingOnlyToolUseStream(
          'The user is asking if `lit` is installed. Let me verify.',
        ),
    ]),
  });

  await runner.openSession({
    sessionId: 'cli:tooluse-empty-session',
    source: {
      kind: 'cli',
      interactive: true,
    },
  });
  await runner.postMessage('cli:tooluse-empty-session', {
    text: 'lit 工具你已经安装了吗？',
  });
  await runner.waitForSessionIdle('cli:tooluse-empty-session');

  const backlog = runner.events.getBacklog('cli:tooluse-empty-session');

  // A text_final must be published carrying the thinking content so the
  // channel adapter has something to deliver to the user. (The runner also
  // double-publishes from agent_end on this path — same as DeepSeek R1's
  // final-thinking-only behavior — so we assert ≥1, not exactly 1.)
  const finalTextEvents = backlog.filter((entry) => entry.event.type === 'text_final');
  assert.ok(finalTextEvents.length >= 1, 'expected at least one text_final event');
  for (const entry of finalTextEvents) {
    assert.match((entry.event as { text: string }).text, /lit/);
  }

  // The persisted assistant entry must carry the thinking text as content,
  // not an empty string — otherwise resumed sessions show a phantom turn.
  const sessionEntries = await readSessionLog(runner, 'cli:tooluse-empty-session');
  const assistantEntries = sessionEntries.filter((entry) => entry.role === 'assistant');
  assert.equal(assistantEntries.length, 1);
  assert.match(String(assistantEntries[0]?.content ?? ''), /lit/);
});

test('AgentRunner surfaces a missing API key as an error event instead of crashing', async (t) => {
  const { workspace, security } = await createSecurityFixture(t);
  await security.load();

  const runner = await AgentRunner.create({
    workspace,
    security,
  });

  await runner.openSession({
    sessionId: 'cli:no-key-session',
    source: {
      kind: 'cli',
      interactive: true,
    },
  });
  await runner.postMessage('cli:no-key-session', {
    text: 'hello',
  });
  await runner.waitForSessionIdle('cli:no-key-session');

  const backlog = runner.events.getBacklog('cli:no-key-session');
  const errorEvent = backlog.find((entry) => entry.event.type === 'error');

  assert.ok(errorEvent);
  assert.match(
    errorEvent?.event.type === 'error' ? errorEvent.event.message : '',
    /Missing API key for provider "anthropic"/,
  );

  const sessionEntries = await readSessionLog(runner, 'cli:no-key-session');

  assert.ok(
    sessionEntries.some(
      (entry) =>
        entry.role === 'error' &&
        typeof entry.message === 'string' &&
        entry.message.includes('Missing API key for provider "anthropic"'),
    ),
  );
});

test('AgentRunner publishes detailed tool failure messages', async (t) => {
  const { workspace, security } = await createSecurityFixture(t, {
    secrets: {
      ANTHROPIC_API_KEY: 'test-anthropic-key',
    },
  });
  await security.load();

  const runner = await AgentRunner.create({
    workspace,
    security,
    streamFn: createSequentialStreamFn([
      () =>
        createToolCallResponseStream({
          type: 'toolCall',
          id: 'call-container-run',
          name: 'memory_add',
          arguments: {
            key: 'test/fail',
            content: '   ',
          },
        }),
      () => createTextResponseStream('The memory add failed because the key was empty.'),
    ]),
  });

  await runner.openSession({
    sessionId: 'cli:tool-error-session',
    source: {
      kind: 'cli',
      interactive: true,
    },
  });
  await runner.postMessage('cli:tool-error-session', {
    text: 'Run the Python script in a container.',
  });
  await runner.waitForSessionIdle('cli:tool-error-session');

  const backlog = runner.events.getBacklog('cli:tool-error-session');
  const toolResultEvent = backlog.find(
    (entry) => entry.event.type === 'tool_result' && entry.event.tool === 'memory_add',
  );

  assert.ok(toolResultEvent);
  assert.equal(toolResultEvent?.event.type, 'tool_result');
  assert.equal(toolResultEvent?.event.isError, true);
  assert.ok(
    toolResultEvent?.event.type === 'tool_result' && typeof toolResultEvent.event.text === 'string'
      && toolResultEvent.event.text.length > 0,
    'error text is non-empty',
  );
});

test('AgentRunner rebuilds and reuses persisted session index across restarts', async (t) => {
  const { workspace, security } = await createSecurityFixture(t, {
    secrets: {
      ANTHROPIC_API_KEY: 'test-anthropic-key',
    },
  });
  await security.load();

  const runner = await AgentRunner.create({
    workspace,
    security,
    streamFn: createSequentialStreamFn([
      () => createTextResponseStream('first reply'),
    ]),
  });

  await runner.openSession({
    sessionId: 'cli:persisted-session',
    source: {
      kind: 'cli',
      interactive: true,
    },
  });
  await runner.postMessage('cli:persisted-session', {
    text: 'hello persistence',
  });
  await runner.waitForSessionIdle('cli:persisted-session');

  const indexedSessions = await runner.listSessions({ kind: 'cli' });
  assert.equal(indexedSessions.length, 1);
  assert.equal(indexedSessions[0]?.sessionId, 'cli:persisted-session');

  const restoredRunner = await AgentRunner.create({
    workspace,
    security,
    streamFn: createSequentialStreamFn([
      () => createTextResponseStream('second reply'),
    ]),
  });

  const restoredSessions = await restoredRunner.listSessions({ kind: 'cli' });
  assert.equal(restoredSessions.length, 1);
  assert.equal(restoredSessions[0]?.sessionId, 'cli:persisted-session');
  assert.equal(restoredSessions[0]?.status, 'idle');
  assert.equal(restoredSessions[0]?.lastEventId, 0);
  assert.equal(restoredSessions[0]?.messageCount, 2);
  assert.equal(restoredSessions[0]?.description, 'hello persistence');
  assert.equal(restoredSessions[0]?.lastMessagePreview, 'first reply');

  await restoredRunner.openSession({
    sessionId: 'cli:persisted-session',
    source: {
      kind: 'cli',
      interactive: true,
    },
  });

  await restoredRunner.postMessage('cli:persisted-session', {
    text: 'continue persistence',
  });
  await restoredRunner.waitForSessionIdle('cli:persisted-session');

  const sessionEntries = await readSessionLog(
    restoredRunner,
    'cli:persisted-session',
  );
  assert.equal(
    sessionEntries.filter((entry) => entry.type === 'session_started').length,
    1,
  );
  assert.ok(
    sessionEntries.some(
      (entry) => entry.role === 'assistant' && entry.content === 'second reply',
    ),
  );
});

test('AgentRunner injects session resumption context when reopening a persisted session', async (t) => {
  const { workspace, security } = await createSecurityFixture(t, {
    secrets: {
      ANTHROPIC_API_KEY: 'test-anthropic-key',
    },
  });
  await security.load();

  const runner = await AgentRunner.create({
    workspace,
    security,
    streamFn: createSequentialStreamFn([
      () => createTextResponseStream('first reply about architecture'),
    ]),
  });

  await runner.openSession({
    sessionId: 'cli:resumption-session',
    source: { kind: 'cli', interactive: true },
  });
  await runner.postMessage('cli:resumption-session', {
    text: 'Explain the container sandbox model',
  });
  await runner.waitForSessionIdle('cli:resumption-session');

  // Create a second runner instance (simulates agent restart).
  let capturedMessages: Context['messages'] = [];
  const restoredRunner = await AgentRunner.create({
    workspace,
    security,
    streamFn: createSequentialStreamFn([
      (context) => {
        capturedMessages = context.messages;
        return createTextResponseStream('resumed reply');
      },
    ]),
  });

  await restoredRunner.openSession({
    sessionId: 'cli:resumption-session',
    source: { kind: 'cli', interactive: true },
  });
  await restoredRunner.postMessage('cli:resumption-session', {
    text: 'Continue the discussion',
  });
  await restoredRunner.waitForSessionIdle('cli:resumption-session');

  const resumptionBlock = capturedMessages.find(
    (msg) =>
      msg.role === 'user' &&
      JSON.stringify(msg.content).includes('Session resumption context'),
  );
  assert.ok(resumptionBlock, 'resumption context should be injected for a persisted session');
  const resumptionText = JSON.stringify(resumptionBlock!.content);
  assert.ok(
    resumptionText.includes('container sandbox model') ||
    resumptionText.includes('architecture'),
    'resumption context should include prior conversation content',
  );
});

test('AgentRunner does not duplicate the new user message on the first turn after resume', async (t) => {
  // Regression: when a channel-driven session resumes (e.g. Telegram receives
  // a message for an existing chat), the new user message was previously
  // appearing twice in the LLM context. The DB-restore path and the
  // in-memory `messages` list both included it, and they were concatenated.
  const { workspace, security } = await createSecurityFixture(t, {
    secrets: {
      ANTHROPIC_API_KEY: 'test-anthropic-key',
    },
  });
  await security.load();

  const runner = await AgentRunner.create({
    workspace,
    security,
    streamFn: createSequentialStreamFn([
      () => createTextResponseStream('first reply'),
    ]),
  });

  await runner.openSession({
    sessionId: 'cli:dup-check-session',
    source: { kind: 'cli', interactive: true },
  });
  await runner.postMessage('cli:dup-check-session', {
    text: 'original turn',
  });
  await runner.waitForSessionIdle('cli:dup-check-session');

  let capturedMessages: Context['messages'] = [];
  const restoredRunner = await AgentRunner.create({
    workspace,
    security,
    streamFn: createSequentialStreamFn([
      (context) => {
        capturedMessages = context.messages;
        return createTextResponseStream('resumed reply');
      },
    ]),
  });

  await restoredRunner.openSession({
    sessionId: 'cli:dup-check-session',
    source: { kind: 'cli', interactive: true },
  });
  await restoredRunner.postMessage('cli:dup-check-session', {
    text: 'hi',
  });
  await restoredRunner.waitForSessionIdle('cli:dup-check-session');

  // Look at user messages and count the ones whose visible text is exactly
  // the new turn input. Content may be a string or an array of parts; the
  // resumption context block is a long "Session resumption context: ..."
  // string and won't be miscounted.
  const userTexts = capturedMessages
    .filter((msg) => msg.role === 'user')
    .map((msg) => {
      if (typeof msg.content === 'string') return msg.content.trim();
      if (Array.isArray(msg.content)) {
        return msg.content
          .map((c) => (typeof c === 'object' && c && 'text' in c ? String((c as { text: unknown }).text) : ''))
          .join('')
          .trim();
      }
      return '';
    });
  const hiUserCount = userTexts.filter((t) => t === 'hi').length;
  assert.equal(
    hiUserCount,
    1,
    `new user message "hi" must appear exactly once in the LLM context (got ${hiUserCount})`,
  );
});

test('AgentRunner restores user-message attachments on the first turn after resume', async (t) => {
  // Regression: before this fix, when a session was rehydrated from DB (e.g.
  // after a gateway redeploy), `buildResumptionMessages` read only the text
  // content of historical user entries. Any attachments on those entries —
  // including the current turn's brand-new attachment, which the postMessage
  // handler had just inlined — were dropped when `transformContext` replaced
  // the in-memory message list with the DB-restored one. Result: vision models
  // saw plain text and had no idea a file was ever attached. Observed in prod
  // as a kimi-k2.6 reply of literally "&" (thinking-only fallback).
  const { workspace, security, agentId } = await createSecurityFixture(t, {
    secrets: {
      ANTHROPIC_API_KEY: 'test-anthropic-key',
    },
  });
  await security.load();

  const attachmentStore = await DbAttachmentStore.open();
  t.after(() => attachmentStore.close());
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'openhermit-resume-att-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const attachmentStorage = new LocalAttachmentStorage({ root });

  // Minimal valid 1x1 PNG so magic-bytes.js can sniff `image/png`.
  const PNG_BYTES = Buffer.from(
    '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4' +
      '890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082',
    'hex',
  );

  const sessionId = 'cli:resume-att-session';
  const attachmentId = `att_${randomBytes(16).toString('hex')}`;
  const putResult = await attachmentStorage.put({
    agentId,
    sessionId,
    attachmentId,
    filename: 'pic.png',
    contentType: 'image/png',
    body: Readable.from(PNG_BYTES),
  });
  await attachmentStore.create({
    id: attachmentId,
    agentId,
    sessionId,
    uploaderUserId: null,
    originalName: 'pic.png',
    safeName: 'pic.png',
    mimeType: 'image/png',
    sizeBytes: putResult.sizeBytes,
    sha256: putResult.sha256,
    storageProvider: attachmentStorage.name,
    storageKey: putResult.storageKey,
  });

  const sessionAttachment: SessionAttachment = {
    id: attachmentId,
    type: 'file',
    name: 'pic.png',
    mimeType: 'image/png',
    size: PNG_BYTES.length,
    sha256: putResult.sha256,
    sandboxPath: '/sandbox/pic.png',
    materializationState: 'copied',
  };

  const runner1 = await AgentRunner.create({
    workspace,
    security,
    attachmentStore,
    attachmentStorage,
    streamFn: createSequentialStreamFn([
      () => createTextResponseStream('first reply'),
    ]),
  });
  await runner1.openSession({
    sessionId,
    source: { kind: 'cli', interactive: true },
  });
  await runner1.postMessage(sessionId, {
    text: 'look at this',
    attachments: [sessionAttachment],
  });
  await runner1.waitForSessionIdle(sessionId);

  // Fresh runner instance simulates a gateway restart: in-memory session is
  // gone, but the persistent DB + storage are shared.
  let capturedMessages: Context['messages'] = [];
  const runner2 = await AgentRunner.create({
    workspace,
    security,
    attachmentStore,
    attachmentStorage,
    streamFn: createSequentialStreamFn([
      (context) => {
        capturedMessages = context.messages;
        return createTextResponseStream('second reply');
      },
    ]),
  });
  await runner2.openSession({
    sessionId,
    source: { kind: 'cli', interactive: true },
  });
  await runner2.postMessage(sessionId, {
    text: 'how about this one',
    attachments: [sessionAttachment],
  });
  await runner2.waitForSessionIdle(sessionId);

  const hasAttachmentBlock = (msg: { content: unknown }): boolean => {
    if (!Array.isArray(msg.content)) return false;
    return (msg.content as unknown[]).some((part) => {
      if (typeof part !== 'object' || part === null) return false;
      const p = part as { type?: string; text?: string };
      if (p.type === 'image') return true;
      if (p.type === 'text' && typeof p.text === 'string' && p.text.includes('[attachment]')) {
        return true;
      }
      return false;
    });
  };

  const userMessages = capturedMessages.filter((m) => m.role === 'user');
  const withAttachmentBlock = userMessages.filter(hasAttachmentBlock);
  assert.ok(
    withAttachmentBlock.length >= 1,
    `expected at least one resumed user message to carry an inlined image or [attachment] reference; got ${withAttachmentBlock.length} of ${userMessages.length} user messages`,
  );
});

test('AgentRunner emits Langfuse traces for LLM steps', async (t) => {
  const { workspace, security } = await createSecurityFixture(t, {
    secrets: {
      ANTHROPIC_API_KEY: 'test-anthropic-key',
    },
  });
  await security.load();

  const langfuse = new FakeLangfuseClient();
  const runner = await AgentRunner.create({
    workspace,
    security,
    langfuse,
    streamFn: createSequentialStreamFn([
      () => createTextResponseStream('hello with trace'),
    ]),
  });

  await runner.openSession({
    sessionId: 'cli:langfuse-session',
    source: {
      kind: 'cli',
      interactive: true,
    },
  });
  await runner.postMessage('cli:langfuse-session', {
    text: 'trace this request',
  });
  await runner.waitForSessionIdle('cli:langfuse-session');

  // Turn trace is created by startTurnTrace; LLM generation is a child of it.
  assert.equal(langfuse.traces.length, 1);
  assert.equal(langfuse.traces[0]?.body.name, 'openhermit.turn');
  assert.equal(langfuse.traces[0]?.body.sessionId, 'cli:langfuse-session');
  assert.equal((langfuse.traces[0]?.body.metadata as Record<string, unknown>)?.turnNumber, 1);
  assert.equal(langfuse.traces[0]?.client.generations.length, 1);
  assert.equal(
    langfuse.traces[0]?.client.generations[0]?.body.name,
    'llm_call',
  );
  assert.equal(
    langfuse.traces[0]?.client.generations[0]?.body.model,
    'claude-opus-4-5',
  );
  assert.equal(
    ((langfuse.traces[0]?.client.generations[0]?.body.input as Record<string, unknown>)?.messages as Array<Record<string, unknown>>)[0]?.role,
    'user',
  );
  assert.equal(
    ((langfuse.traces[0]?.client.generations[0]?.client.ended[0]?.output as Record<string, unknown>)?.model),
    'claude-opus-4-5',
  );
  assert.equal(
    (((langfuse.traces[0]?.client.generations[0]?.client.ended[0]?.output as Record<string, unknown>)?.content as Array<Record<string, unknown>>)[0]?.text),
    'hello with trace',
  );
  // Turn trace is updated with output when turn ends
  assert.ok(langfuse.traces[0]?.client.updates.length > 0);
});

test('AgentRunner uses a dedicated Langfuse trace name for internal checkpoints', async (t) => {
  const { workspace, security } = await createSecurityFixture(t, {
    secrets: {
      ANTHROPIC_API_KEY: 'test-anthropic-key',
    },
  });
  await security.load();

  const langfuse = new FakeLangfuseClient();
  const runner = await AgentRunner.create({
    workspace,
    security,
    langfuse,
    streamFn: createSequentialStreamFn([
      () => createTextResponseStream('first reply'),
      () =>
        createTextResponseStream(
          JSON.stringify({
            summary: 'checkpoint summary',
            sessionWorkingMemory: '# Session Working Memory\ncheckpoint memory',
          }),
        ),
    ]),
  });

  await runner.openSession({
    sessionId: 'cli:checkpoint-trace',
    source: {
      kind: 'cli',
      interactive: true,
    },
  });
  await runner.postMessage('cli:checkpoint-trace', {
    text: 'checkpoint this session',
  });
  await runner.waitForSessionIdle('cli:checkpoint-trace');
  await runner.checkpointSession('cli:checkpoint-trace', 'manual');

  // First trace: the user turn (postMessage creates a turn trace)
  assert.equal(langfuse.traces[0]?.body.name, 'openhermit.turn');
  assert.equal(langfuse.traces[0]?.body.sessionId, 'cli:checkpoint-trace');
  // The LLM call for "first reply" is a generation on the turn trace, not a separate trace
  assert.equal(langfuse.traces[0]?.client.generations.length, 1);

  // Second trace: standalone trace from the introspection agent's LLM call
  assert.equal(langfuse.traces[1]?.body.name, 'openhermit.introspection');
});

test('AgentRunner denies memory tools when no user role is resolved (guest-level)', async (t) => {
  const { workspace, security } = await createSecurityFixture(t, {
    secrets: { ANTHROPIC_API_KEY: 'test-anthropic-key' },
  });
  await security.load();

  // Capture the tools available to the agent
  let capturedTools: string[] = [];
  const runner = await AgentRunner.create({
    workspace,
    security,
    streamFn: async (_model, context) => {
      capturedTools = (context as any).tools?.map((t: any) => t.name) ?? [];
      return createTextResponseStream('ok');
    },
  });

  // schedule source has no channel user ID → no user resolved → guest
  await runner.openSession({
    sessionId: 'schedule:guest-check',
    source: { kind: 'schedule', interactive: false },
  });
  await runner.postMessage('schedule:guest-check', { text: 'hi' });
  await runner.waitForSessionIdle('schedule:guest-check');

  assert.ok(!capturedTools.includes('memory_add'), 'guest should not have memory_add');
  assert.ok(!capturedTools.includes('memory_recall'), 'guest should not have memory_recall');
  assert.ok(!capturedTools.includes('instruction_update'), 'guest should not have instruction_update');
  assert.ok(!capturedTools.includes('session_list'), 'guest should not have session_list');
});

test('AgentRunner populates userIds on session open and reopen', async (t) => {
  const { workspace, security, agentId } = await createSecurityFixture(t, {
    secrets: { ANTHROPIC_API_KEY: 'test-anthropic-key' },
  });
  await security.load();

  const runner = await AgentRunner.create({
    workspace,
    security,
    streamFn: createSequentialStreamFn([
      () => createTextResponseStream('first reply'),
      () => createTextResponseStream('second reply'),
    ]),
  });

  // CLI source bootstraps owner
  await runner.openSession({
    sessionId: 'cli:userids-test',
    source: { kind: 'cli', interactive: true },
  });
  await runner.postMessage('cli:userids-test', { text: 'hello' });
  await runner.waitForSessionIdle('cli:userids-test');

  // Check session in DB has userIds populated
  const store = await DbInternalStateStore.open();
  t.after(() => store.close());
  const session = await store.sessions.get({ agentId }, 'cli:userids-test');
  assert.ok(session, 'session should exist in DB');
  assert.ok(Array.isArray(session.userIds), 'userIds should be an array');
  assert.ok(session.userIds!.length > 0, 'userIds should have at least one entry');
  assert.ok(session.userIds!.includes('usr-owner'), 'userIds should include the owner');
});

test('AgentRunner.appendMessage with appendAs=assistant stores synthetic assistant entry without user_message', async (t) => {
  const { workspace, security } = await createSecurityFixture(t, {
    secrets: { ANTHROPIC_API_KEY: 'test-anthropic-key' },
  });
  await security.load();

  const runner = await AgentRunner.create({
    workspace,
    security,
    streamFn: createSequentialStreamFn([]),
  });

  const sessionId = 'cli:append-assistant';
  await runner.openSession({
    sessionId,
    source: { kind: 'cli', interactive: true },
  });

  const result = await runner.appendMessage(sessionId, {
    messageId: 'msg-assist-1',
    text: 'owner-as-assistant reply',
    appendAs: 'assistant',
    sender: { channel: 'cli', channelUserId: 'owner' },
  });
  assert.deepEqual(result, { appended: true });
  await runner.waitForSessionIdle(sessionId);

  const entries = await readSessionLog(runner, sessionId);
  const assistantEntry = entries.find(
    (e) => e.role === 'assistant' && e.content === 'owner-as-assistant reply',
  );
  assert.ok(assistantEntry, 'assistant entry should be persisted');
  const metadata = assistantEntry!.metadata as Record<string, unknown> | undefined;
  assert.equal(metadata?.synthetic, true, 'metadata.synthetic should be true');
  assert.ok(metadata?.appendedBy, 'metadata.appendedBy should be set');
  assert.equal(assistantEntry!.provider, undefined, 'provider should be unset');
  assert.equal(assistantEntry!.model, undefined, 'model should be unset');

  const backlog = runner.events.getBacklog(sessionId);
  assert.ok(
    !backlog.some((entry) => entry.event.type === 'user_message'),
    'no user_message event should be emitted for assistant-role append',
  );
});

test('AgentRunner.appendMessage is idempotent by messageId', async (t) => {
  const { workspace, security } = await createSecurityFixture(t, {
    secrets: { ANTHROPIC_API_KEY: 'test-anthropic-key' },
  });
  await security.load();

  const runner = await AgentRunner.create({
    workspace,
    security,
    streamFn: createSequentialStreamFn([]),
  });

  const sessionId = 'cli:append-idempotent';
  await runner.openSession({
    sessionId,
    source: { kind: 'cli', interactive: true },
  });

  const first = await runner.appendMessage(sessionId, {
    messageId: 'msg-dup',
    text: 'first',
    appendAs: 'user',
  });
  assert.deepEqual(first, { appended: true });
  await runner.waitForSessionIdle(sessionId);

  const second = await runner.appendMessage(sessionId, {
    messageId: 'msg-dup',
    text: 'first',
    appendAs: 'user',
  });
  assert.deepEqual(second, { appended: false, deduped: true });

  const entries = await readSessionLog(runner, sessionId);
  const matches = entries.filter((e) => e.messageId === 'msg-dup');
  assert.equal(matches.length, 1, 'only one entry persisted for duplicate messageId');
});

test('AgentRunner.appendMessage honours occurredAt as the persisted ts', async (t) => {
  const { workspace, security } = await createSecurityFixture(t, {
    secrets: { ANTHROPIC_API_KEY: 'test-anthropic-key' },
  });
  await security.load();

  const runner = await AgentRunner.create({
    workspace,
    security,
    streamFn: createSequentialStreamFn([]),
  });

  const sessionId = 'cli:append-occurredat';
  await runner.openSession({
    sessionId,
    source: { kind: 'cli', interactive: true },
  });

  const occurredAt = '2024-01-02T03:04:05.000Z';
  await runner.appendMessage(sessionId, {
    messageId: 'msg-ts',
    text: 'backfilled',
    appendAs: 'assistant',
    occurredAt,
  });
  await runner.waitForSessionIdle(sessionId);

  const entries = await readSessionLog(runner, sessionId);
  const entry = entries.find((e) => e.messageId === 'msg-ts');
  assert.ok(entry, 'entry persisted');
  assert.equal(entry!.ts, occurredAt, 'persisted ts should match occurredAt');
});
