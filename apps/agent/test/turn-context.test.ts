import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { AgentMessage } from '@earendil-works/pi-agent-core';

import {
  attachTurnContextNote,
  formatTurnContextNote,
} from '../src/agent-runner/turn-context.js';

const at = new Date('2026-11-22T13:45:59.123Z');

test('formatTurnContextNote states minute-precision UTC time and weekday', () => {
  assert.equal(
    formatTurnContextNote({ at }),
    '[Turn context, added by the runtime, not written by the user] Current time: 2026-11-22 13:45 UTC (Sunday).',
  );
});

test('formatTurnContextNote names the group sender with role', () => {
  const note = formatTurnContextNote({
    at,
    sender: { userId: 'usr-bob', name: 'Bob', role: 'guest' },
  });
  assert.match(note, /Sender: `usr-bob` \(Bob\), role: guest\.$/);
});

test('attachTurnContextNote annotates only the last user message, without mutating input', () => {
  const first: AgentMessage = { role: 'user', content: 'earlier', timestamp: 1 };
  const last: AgentMessage = {
    role: 'user',
    content: [{ type: 'text', text: 'what time is it?' }],
    timestamp: 2,
  };
  const messages: AgentMessage[] = [first, last];
  const snapshot = JSON.stringify(messages);

  const out = attachTurnContextNote(messages, 'NOTE');

  assert.equal(JSON.stringify(messages), snapshot, 'input must not be mutated');
  assert.equal(out[0], first, 'earlier messages are passed through by reference');
  assert.deepEqual((out[1] as { content: unknown }).content, [
    { type: 'text', text: 'what time is it?' },
    { type: 'text', text: 'NOTE' },
  ]);
});

test('attachTurnContextNote appends to string content and skips trailing non-user messages', () => {
  const messages = [
    { role: 'user', content: 'run the tool', timestamp: 1 },
    { role: 'toolResult', toolCallId: 'c1', toolName: 'x', content: [], isError: false, timestamp: 2 },
  ] as unknown as AgentMessage[];

  const out = attachTurnContextNote(messages, 'NOTE');

  assert.equal((out[0] as { content: unknown }).content, 'run the tool\n\nNOTE');
  assert.equal(out[1], messages[1]);
});

test('attachTurnContextNote is a no-op without a user message', () => {
  const messages: AgentMessage[] = [];
  assert.equal(attachTurnContextNote(messages, 'NOTE'), messages);
});
