import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { AgentMessage } from '@mariozechner/pi-agent-core';

import {
  CONTEXT_OVERFLOW_MAX_RETRIES_ENV,
  CONTEXT_OVERFLOW_MIN_RETAINED_MESSAGES,
  DEFAULT_CONTEXT_OVERFLOW_MAX_RETRIES,
  resolveContextOverflowMaxRetries,
  shrinkMessagesForRetry,
} from '../src/agent-runner/context-overflow.js';

// --- Minimal message factories (shape-compatible with pi-ai) --------------

const user = (text: string): AgentMessage =>
  ({ role: 'user', content: [{ type: 'text', text }] }) as unknown as AgentMessage;

const assistant = (text: string, stopReason: string = 'stop'): AgentMessage =>
  ({
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'anthropic-messages',
    provider: 'test',
    model: 'test',
    usage: {},
    stopReason,
    timestamp: '2026-10-31T00:00:00.000Z',
  }) as unknown as AgentMessage;

const toolCall = (id: string, name: string): AgentMessage =>
  ({
    role: 'assistant',
    content: [{ type: 'toolCall', id, name, arguments: {} }],
    api: 'anthropic-messages',
    provider: 'test',
    model: 'test',
    usage: {},
    stopReason: 'toolUse',
    timestamp: '2026-10-31T00:00:00.000Z',
  }) as unknown as AgentMessage;

const toolResult = (id: string, name: string): AgentMessage =>
  ({
    role: 'toolResult',
    toolCallId: id,
    toolName: name,
    content: [{ type: 'text', text: 'ok' }],
    isError: false,
    timestamp: '2026-10-31T00:00:00.000Z',
  }) as unknown as AgentMessage;

const role = (m: AgentMessage): string => (m as { role: string }).role;

// --- resolveContextOverflowMaxRetries -------------------------------------

test('resolve: default when env unset', () => {
  assert.equal(resolveContextOverflowMaxRetries({}), DEFAULT_CONTEXT_OVERFLOW_MAX_RETRIES);
});

test('resolve: default when env blank', () => {
  assert.equal(
    resolveContextOverflowMaxRetries({ [CONTEXT_OVERFLOW_MAX_RETRIES_ENV]: '   ' }),
    DEFAULT_CONTEXT_OVERFLOW_MAX_RETRIES,
  );
});

test('resolve: explicit numeric override', () => {
  assert.equal(resolveContextOverflowMaxRetries({ [CONTEXT_OVERFLOW_MAX_RETRIES_ENV]: '3' }), 3);
});

test('resolve: 0 disables recovery', () => {
  assert.equal(resolveContextOverflowMaxRetries({ [CONTEXT_OVERFLOW_MAX_RETRIES_ENV]: '0' }), 0);
});

test('resolve: negative falls back to default', () => {
  assert.equal(
    resolveContextOverflowMaxRetries({ [CONTEXT_OVERFLOW_MAX_RETRIES_ENV]: '-5' }),
    DEFAULT_CONTEXT_OVERFLOW_MAX_RETRIES,
  );
});

test('resolve: non-numeric falls back to default', () => {
  assert.equal(
    resolveContextOverflowMaxRetries({ [CONTEXT_OVERFLOW_MAX_RETRIES_ENV]: 'lots' }),
    DEFAULT_CONTEXT_OVERFLOW_MAX_RETRIES,
  );
});

// --- shrinkMessagesForRetry -----------------------------------------------

test('shrink: returns a fresh array, never the input reference', () => {
  const messages = [user('hi'), assistant('hello')];
  const out = shrinkMessagesForRetry(messages);
  assert.notEqual(out, messages);
});

test('shrink: does not mutate the input array', () => {
  const messages = [user('hi'), assistant('bad', 'error')];
  const snapshot = [...messages];
  shrinkMessagesForRetry(messages);
  assert.deepEqual(messages, snapshot);
});

test('shrink: drops a trailing errored assistant placeholder', () => {
  const messages = [user('q'), assistant('partial', 'error')];
  const out = shrinkMessagesForRetry(messages);
  // last real content is the user message → continue() precondition holds
  assert.equal(role(out[out.length - 1]!), 'user');
  assert.ok(out.every((m) => (m as { stopReason?: string }).stopReason !== 'error'));
});

test('shrink: drops a trailing aborted assistant placeholder', () => {
  const messages = [user('q'), assistant('partial', 'aborted')];
  const out = shrinkMessagesForRetry(messages);
  assert.equal(role(out[out.length - 1]!), 'user');
});

test('shrink: result ends on a user or tool-result message', () => {
  // Long history, ending with the triggering user turn + failed generation.
  const messages: AgentMessage[] = [];
  for (let i = 0; i < 30; i += 1) {
    messages.push(user(`u${i}`), assistant(`a${i}`));
  }
  messages.push(user('trigger'), assistant('failed', 'error'));
  const out = shrinkMessagesForRetry(messages);
  const last = role(out[out.length - 1]!);
  assert.ok(last === 'user' || last === 'toolResult', `last role was ${last}`);
});

test('shrink: aggressively reduces a long transcript (~half)', () => {
  const messages: AgentMessage[] = [];
  for (let i = 0; i < 40; i += 1) {
    messages.push(user(`u${i}`), assistant(`a${i}`));
  }
  const out = shrinkMessagesForRetry(messages);
  assert.ok(out.length < messages.length, 'should shrink');
  assert.ok(out.length <= Math.ceil(messages.length / 2) + 2, `got ${out.length}`);
});

test('shrink: short transcript kept whole except the trailing assistant', () => {
  // Floor exceeds length so the rolling window keeps everything; step 3 still
  // drops the trailing assistant so the result ends on a user message.
  const messages = [user('a'), assistant('b'), user('c'), assistant('d')];
  const out = shrinkMessagesForRetry(messages);
  assert.deepEqual(out.map(role), ['user', 'assistant', 'user']);
});

test('shrink: short transcript ending in user is kept whole', () => {
  const messages = [user('a'), assistant('b'), user('c')];
  const out = shrinkMessagesForRetry(messages);
  assert.equal(out.length, messages.length);
  assert.equal(role(out[out.length - 1]!), 'user');
});

test('shrink: keeps tool-call/result pairs intact', () => {
  const messages: AgentMessage[] = [];
  for (let i = 0; i < 20; i += 1) {
    messages.push(user(`u${i}`), assistant(`a${i}`));
  }
  // A tool pair near the retained tail, followed by the triggering user turn.
  messages.push(toolCall('t1', 'web_search'), toolResult('t1', 'web_search'));
  messages.push(user('trigger'));
  const out = shrinkMessagesForRetry(messages);
  const callIdx = out.findIndex(
    (m) => role(m) === 'assistant' && (m as { content: { type: string }[] }).content[0]?.type === 'toolCall',
  );
  if (callIdx !== -1) {
    // If the tool call survived the window, its result must too (no orphan).
    const next = out[callIdx + 1];
    assert.ok(next && role(next) === 'toolResult', 'tool call kept without its result');
  }
});

test('shrink: a larger minRetained keeps more messages', () => {
  const messages: AgentMessage[] = [];
  for (let i = 0; i < 40; i += 1) {
    messages.push(user(`u${i}`), assistant(`a${i}`));
  }
  const def = shrinkMessagesForRetry(messages);
  const more = shrinkMessagesForRetry(messages, { minRetained: 60 });
  assert.ok(more.length > def.length, `expected ${more.length} > ${def.length}`);
});

test('MIN_RETAINED constant is a sane positive number', () => {
  assert.ok(CONTEXT_OVERFLOW_MIN_RETAINED_MESSAGES > 0);
});
