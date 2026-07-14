import assert from 'node:assert/strict';
import { test } from 'node:test';

import { agentEndClosesStream } from '../src/app.js';

const agentEnd = (messageId?: string) =>
  ({ type: 'agent_end', sessionId: 's', eventId: 'e', ...(messageId ? { messageId } : {}) }) as never;

test('agent_end for this request message closes the stream', () => {
  assert.equal(agentEndClosesStream(agentEnd('B'), 'B'), true);
});

test('a concurrent turn agent_end (different messageId) does not close this stream', () => {
  assert.equal(agentEndClosesStream(agentEnd('A'), 'B'), false);
});

test('backward-compat: agent_end without messageId closes on any (older runners)', () => {
  assert.equal(agentEndClosesStream(agentEnd(undefined), 'B'), true);
});

test('backward-compat: request with no messageId closes on any agent_end', () => {
  assert.equal(agentEndClosesStream(agentEnd('A'), undefined), true);
});

test('non agent_end events never close the stream', () => {
  const textFinal = { type: 'text_final', sessionId: 's', eventId: 'e', text: 'x' } as never;
  assert.equal(agentEndClosesStream(textFinal, 'B'), false);
});
