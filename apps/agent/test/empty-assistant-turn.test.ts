import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { AgentMessage } from '@mariozechner/pi-agent-core';

import {
  isEmptyAssistantTurn,
  stripEmptyAssistantTurns,
} from '../src/agent-runner/message-utils.js';

/** The placeholder pi-agent-core pushes when a stream throws mid-turn. */
const failurePlaceholder = (stopReason: 'error' | 'aborted'): AgentMessage =>
  ({
    role: 'assistant',
    content: [{ type: 'text', text: '' }],
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: 'claude',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    stopReason,
    errorMessage: 'insufficient credits',
    timestamp: 1,
  }) as unknown as AgentMessage;

const userMsg = (text: string): AgentMessage =>
  ({ role: 'user', content: [{ type: 'text', text }], timestamp: 1 }) as unknown as AgentMessage;

const assistantMsg = (text: string): AgentMessage =>
  ({ role: 'assistant', content: [{ type: 'text', text }], timestamp: 1 }) as unknown as AgentMessage;

const assistantToolCall = (): AgentMessage =>
  ({
    role: 'assistant',
    content: [{ type: 'toolCall', id: 't1', name: 'bash', arguments: {} }],
    stopReason: 'toolUse',
    timestamp: 1,
  }) as unknown as AgentMessage;

test('isEmptyAssistantTurn flags the empty error/aborted placeholders', () => {
  assert.equal(isEmptyAssistantTurn(failurePlaceholder('error')), true);
  assert.equal(isEmptyAssistantTurn(failurePlaceholder('aborted')), true);
  // Whitespace-only content is still empty.
  assert.equal(isEmptyAssistantTurn(assistantMsg('   \n ')), true);
});

test('isEmptyAssistantTurn does not flag real content or other roles', () => {
  assert.equal(isEmptyAssistantTurn(assistantMsg('hello')), false);
  assert.equal(isEmptyAssistantTurn(assistantToolCall()), false); // tool call is usable content
  assert.equal(isEmptyAssistantTurn(userMsg('')), false); // never touch user/tool messages
});

test('stripEmptyAssistantTurns removes the poison left by a depleted turn', () => {
  // Transcript after a credit-depletion failure: user asked, the failed turn
  // recorded an empty assistant placeholder, then the user retried.
  const history = [
    userMsg('first question'),
    failurePlaceholder('error'),
    userMsg('retry after top-up'),
  ];
  const cleaned = stripEmptyAssistantTurns(history);
  assert.deepEqual(
    cleaned.map((m) => m.role),
    ['user', 'user'],
  );
  // The real messages are preserved verbatim.
  assert.equal((cleaned[0]!.content as { text: string }[])[0]!.text, 'first question');
  assert.equal((cleaned[1]!.content as { text: string }[])[0]!.text, 'retry after top-up');
});

test('stripEmptyAssistantTurns keeps a healthy transcript intact', () => {
  const history = [userMsg('hi'), assistantMsg('hello!'), userMsg('thanks')];
  assert.deepEqual(stripEmptyAssistantTurns(history), history);
});
