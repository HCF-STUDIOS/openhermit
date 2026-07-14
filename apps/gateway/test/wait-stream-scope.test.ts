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
const reconcileCancelError = (correlationId: string) =>
  ({ type: 'error', sessionId: 's', eventId: 'e', message: 'Media was prepared but not sent.', correlationId, reason: 'reconcile_cancel' }) as never;
const mediaError = (correlationId: string) =>
  ({ type: 'error', sessionId: 's', eventId: 'e', message: 'media create failed', correlationId, reason: 'media_error' }) as never;
const pendingMedia = (correlationId: string) =>
  ({ type: 'pending_media', sessionId: 's', eventId: 'e', correlationId }) as never;
const attachment = (correlationId?: string) =>
  ({ type: 'attachment', sessionId: 's', eventId: 'e', attachmentId: 'a', mimeType: 'image/png', kind: 'image', ...(correlationId ? { correlationId } : {}) }) as never;

// ── wait mode: agentEndResolvesWait ─────────────────────────────────────────

test('wait: a concurrent agent_end during the post window (not settled) never resolves', () => {
  // messageId still unknown; without the gate this would match A and resolve B with A's response.
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

test('stream: a plain turn error for another turn is scoped out', () => {
  assert.equal(streamEventInScope(errorEvent('A-boom', 'A'), 'B'), false);
});

test('stream: a reconcile_cancel media error is forwarded session-wide even for another correlationId', () => {
  // The media job id is not a turn trigger; scoping it out would strand the consumer's skeleton.
  assert.equal(streamEventInScope(reconcileCancelError('media-1'), 'B'), true);
});

test('stream: an out-of-band media_error is forwarded session-wide even for another correlationId', () => {
  assert.equal(streamEventInScope(mediaError('media-1'), 'B'), true);
});

test('stream: a turn error whose correlationId collides with a seen media id is NOT leaked cross-stream', () => {
  // A turn error's correlationId can collide with a media id; scope alone must keep it off request B.
  assert.equal(streamEventInScope(errorEvent('turn boom', 'media-1'), 'B'), false);
  assert.equal(streamEventInScope(errorEvent('turn boom', 'media-1'), 'media-1'), true);
});

test('stream: pending_media itself stays session-wide (out-of-band)', () => {
  assert.equal(streamEventInScope(pendingMedia('media-1'), 'B'), true);
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

test('wait: an out-of-band media error is not recorded as the turn error, even on id collision', () => {
  const acc = new WaitTurnAccumulator();
  // The media job id collides with request B's turn trigger.
  acc.record(mediaError('B'));
  acc.record(textFinal('B-text', 'B'));
  assert.equal(acc.get('B').error, undefined, 'a media error must not become the turn error');
  assert.equal(acc.get('B').text, 'B-text');
  // A reconcile_cancel is likewise never a turn error.
  const acc2 = new WaitTurnAccumulator();
  acc2.record(reconcileCancelError('B'));
  assert.equal(acc2.get('B').error, undefined);
});

test('wait: a legacy id-less turn buckets under the empty key', () => {
  const acc = new WaitTurnAccumulator();
  acc.record(textFinal('legacy'));
  assert.equal(acc.get(undefined).text, 'legacy');
});
