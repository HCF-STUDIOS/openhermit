import assert from 'node:assert/strict';
import { test } from 'node:test';

import { agentEndClosesStream } from '../src/app.js';

const agentEnd = (messageId?: string) =>
  ({ type: 'agent_end', sessionId: 's', eventId: 'e', ...(messageId ? { messageId } : {}) }) as never;

const agentEndWithAnswered = (messageId: string | undefined, answeredMessageIds: string[]) =>
  ({ type: 'agent_end', sessionId: 's', eventId: 'e', ...(messageId ? { messageId } : {}), answeredMessageIds }) as never;

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

test('agent_end closes a folded message stream when its id is in answeredMessageIds', () => {
  // B was folded into turn A; B's own turn emits no agent_end, so A's end closes B's stream.
  assert.equal(agentEndClosesStream(agentEndWithAnswered('A', ['A', 'B']), 'B'), true);
  assert.equal(agentEndClosesStream(agentEndWithAnswered('A', ['A', 'B']), 'A'), true);
});

test('agent_end does not close a stream whose id is absent from answeredMessageIds', () => {
  assert.equal(agentEndClosesStream(agentEndWithAnswered('A', ['A', 'B']), 'C'), false);
});

test('answeredMessageIds is authoritative over the single messageId field', () => {
  assert.equal(agentEndClosesStream(agentEndWithAnswered('B', ['A']), 'B'), false);
});
