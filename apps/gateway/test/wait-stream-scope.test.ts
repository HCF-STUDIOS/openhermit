import assert from 'node:assert/strict';
import { test } from 'node:test';

import { agentEndResolvesWait, bufferedEndEligibleToClose } from '../src/app.js';

const agentEnd = (messageId?: string) =>
  ({ type: 'agent_end', sessionId: 's', eventId: 'e', ...(messageId ? { messageId } : {}) }) as never;

// ── wait mode: agentEndResolvesWait ─────────────────────────────────────────

test('wait: a concurrent agent_end during the post window (not settled) never resolves', () => {
  // messageId still unknown; without the gate agentEndClosesStream(ev, undefined)
  // would match A and resolve B with A's response.
  assert.equal(agentEndResolvesWait(agentEnd('A'), undefined, false), false);
});

test('wait: after settle, B resolves on B own agent_end', () => {
  assert.equal(agentEndResolvesWait(agentEnd('B'), 'B', true), true);
});

test('wait: after settle, B does not resolve on A concurrent agent_end', () => {
  assert.equal(agentEndResolvesWait(agentEnd('A'), 'B', true), false);
});

test('wait: genuine no-messageId caller resolves on any agent_end once settled', () => {
  assert.equal(agentEndResolvesWait(agentEnd('A'), undefined, true), true);
});

// ── stream mode: bufferedEndEligibleToClose ─────────────────────────────────

test('stream: with a messageId, any buffered index may close (scoped match guards it)', () => {
  assert.equal(bufferedEndEligibleToClose('B', 0, 3), true);
  assert.equal(bufferedEndEligibleToClose('B', 5, 3), true);
});

test('stream: with no messageId, ends buffered before settle (index < boundary) cannot close', () => {
  assert.equal(bufferedEndEligibleToClose(undefined, 0, 2), false);
  assert.equal(bufferedEndEligibleToClose(undefined, 1, 2), false);
});

test('stream: with no messageId, ends at/after the settle boundary may close', () => {
  assert.equal(bufferedEndEligibleToClose(undefined, 2, 2), true);
  assert.equal(bufferedEndEligibleToClose(undefined, 3, 2), true);
});
