import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  agentEndResolvesWait,
  bufferedEndEligibleToClose,
  streamEventInScope,
  WaitTurnAccumulator,
} from '../src/app.js';

const agentEnd = (messageId?: string) =>
  ({ type: 'agent_end', sessionId: 's', eventId: 'e', ...(messageId ? { messageId } : {}) }) as never;

const textFinal = (text: string, correlationId?: string) =>
  ({ type: 'text_final', sessionId: 's', eventId: 'e', text, ...(correlationId ? { correlationId } : {}) }) as never;
const toolResult = (correlationId?: string) =>
  ({ type: 'tool_result', sessionId: 's', eventId: 'e', tool: 't', toolCallId: 'tc', isError: false, ...(correlationId ? { correlationId } : {}) }) as never;
const errorEvent = (message: string, correlationId?: string) =>
  ({ type: 'error', sessionId: 's', eventId: 'e', message, ...(correlationId ? { correlationId } : {}) }) as never;
const attachment = (correlationId?: string) =>
  ({ type: 'attachment', sessionId: 's', eventId: 'e', attachmentId: 'a', mimeType: 'image/png', kind: 'image', ...(correlationId ? { correlationId } : {}) }) as never;

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

// ── stream mode: streamEventInScope ─────────────────────────────────────────

test('stream: this turn own content is forwarded', () => {
  assert.equal(streamEventInScope(textFinal('mine', 'B'), 'B'), true);
});

test('stream: a concurrent turn content is scoped out', () => {
  assert.equal(streamEventInScope(textFinal('theirs', 'A'), 'B'), false);
  assert.equal(streamEventInScope(toolResult('A'), 'B'), false);
});

test('stream: out-of-band media stays session-wide even for another turn', () => {
  assert.equal(streamEventInScope(attachment('A'), 'B'), true);
});

test('stream: a legacy no-messageId caller receives everything unscoped', () => {
  assert.equal(streamEventInScope(textFinal('anything', 'A'), undefined), true);
});

test('stream: content with no correlationId is forwarded (unscoped)', () => {
  assert.equal(streamEventInScope(textFinal('no-corr'), 'B'), true);
});

// ── wait mode: WaitTurnAccumulator ──────────────────────────────────────────

test('wait: content is bucketed per turn and only the resolving turn is returned', () => {
  const acc = new WaitTurnAccumulator();
  acc.record(textFinal('A-text', 'A'));
  acc.record(toolResult('A'));
  acc.record(textFinal('B-text', 'B'));

  const resolved = acc.get(agentEnd('B').messageId);
  assert.equal(resolved.text, 'B-text', 'must return only B own turn text, never A');
  assert.equal(resolved.toolCalls.length, 0, 'A tool_result must not leak into B');
});

test('wait: a folded message returns the answering turn content (keyed by the end messageId)', () => {
  const acc = new WaitTurnAccumulator();
  // B was folded into turn A; A produced the reply (correlationId = A).
  acc.record(textFinal('A-answers-both', 'A'));
  // The resolving end for request B names A as the trigger.
  const resolved = acc.get('A');
  assert.equal(resolved.text, 'A-answers-both');
});

test('wait: an error is scoped to its turn', () => {
  const acc = new WaitTurnAccumulator();
  acc.record(errorEvent('A-boom', 'A'));
  acc.record(textFinal('B-text', 'B'));
  assert.equal(acc.get('B').error, undefined);
  assert.equal(acc.get('A').error, 'A-boom');
});

test('wait: a legacy id-less turn buckets under the empty key', () => {
  const acc = new WaitTurnAccumulator();
  acc.record(textFinal('legacy'));
  assert.equal(acc.get(undefined).text, 'legacy');
});
