import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { AgentMessage } from '@mariozechner/pi-agent-core';

import { stripReasoningTags, extractAssistantText } from '../src/agent-runner/message-utils.js';

const assistantMsg = (text: string): AgentMessage =>
  ({ role: 'assistant', content: [{ type: 'text', text }], timestamp: 1 }) as unknown as AgentMessage;

test('stripReasoningTags removes a leading think block, keeps the answer', () => {
  assert.equal(
    stripReasoningTags('<think>let me reason about this</think>Hello there'),
    'Hello there',
  );
});

test('stripReasoningTags removes thinking/reasoning variants anywhere', () => {
  assert.equal(stripReasoningTags('A<thinking>hmm</thinking>B'), 'AB');
  assert.equal(stripReasoningTags('<reasoning>x</reasoning>done'), 'done');
});

test('stripReasoningTags is a no-op when there are no tags', () => {
  assert.equal(stripReasoningTags('just a normal reply'), 'just a normal reply');
});

test('stripReasoningTags leaves a pure-reasoning text unchanged (no blanking)', () => {
  const only = '<think>only reasoning, no answer</think>';
  assert.equal(stripReasoningTags(only), only);
});

test('extractAssistantText strips inline reasoning from a text block', () => {
  const msg = assistantMsg('<think>plan</think>Final answer.');
  assert.equal(extractAssistantText(msg), 'Final answer.');
});
