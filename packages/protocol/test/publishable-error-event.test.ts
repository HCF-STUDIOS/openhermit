import assert from 'node:assert/strict';
import test from 'node:test';

import { isPublishableOutboundEvent, type OutboundEventBody } from '../src/index.js';

test('error event accepts an optional correlationId linking it back to a pending_media placeholder', () => {
  const event = {
    type: 'error',
    sessionId: 's1',
    message: 'media generation failed',
    correlationId: 'c1',
  } satisfies OutboundEventBody;

  assert.equal(event.type, 'error');
  assert.equal(event.correlationId, 'c1');
});

test('isPublishableOutboundEvent accepts a pushed error event with and without correlationId', () => {
  assert.equal(
    isPublishableOutboundEvent({ type: 'error', sessionId: 's1', message: 'failed', correlationId: 'c1' }),
    true,
  );
  assert.equal(
    isPublishableOutboundEvent({ type: 'error', sessionId: 's1', message: 'failed' }),
    true,
  );
});

test('isPublishableOutboundEvent rejects an error event missing a message', () => {
  assert.equal(
    isPublishableOutboundEvent({ type: 'error', sessionId: 's1', correlationId: 'c1' }),
    false,
  );
});

test('isPublishableOutboundEvent accepts the known out-of-band reasons and no reason', () => {
  for (const reason of ['reconcile_cancel', 'media_error', undefined]) {
    assert.equal(
      isPublishableOutboundEvent({ type: 'error', sessionId: 's1', message: 'failed', correlationId: 'c1', ...(reason !== undefined ? { reason } : {}) }),
      true,
      `reason ${String(reason)} should be accepted`,
    );
  }
});

test('isPublishableOutboundEvent rejects an error with a null or unknown reason (cannot slip through and be read as a turn error)', () => {
  assert.equal(
    isPublishableOutboundEvent({ type: 'error', sessionId: 's1', message: 'failed', correlationId: 'c1', reason: null }),
    false,
  );
  assert.equal(
    isPublishableOutboundEvent({ type: 'error', sessionId: 's1', message: 'failed', correlationId: 'c1', reason: 'invalid' }),
    false,
  );
});

test('isPublishableOutboundEvent still rejects a runtime-internal type like text_delta', () => {
  assert.equal(
    isPublishableOutboundEvent({ type: 'text_delta', sessionId: 's1', text: 'hi' }),
    false,
  );
});

test('isPublishableOutboundEvent rejects an attachment with size: null (the type is number | undefined, never null)', () => {
  assert.equal(
    isPublishableOutboundEvent({
      type: 'attachment',
      sessionId: 's1',
      attachmentId: 'att_1',
      mimeType: 'image/png',
      kind: 'image',
      size: null,
    }),
    false,
  );
});

test('isPublishableOutboundEvent still accepts an attachment with no size and a numeric size', () => {
  assert.equal(
    isPublishableOutboundEvent({
      type: 'attachment',
      sessionId: 's1',
      attachmentId: 'att_1',
      mimeType: 'image/png',
      kind: 'image',
    }),
    true,
  );
  assert.equal(
    isPublishableOutboundEvent({
      type: 'attachment',
      sessionId: 's1',
      attachmentId: 'att_1',
      mimeType: 'image/png',
      kind: 'image',
      size: 1234,
    }),
    true,
  );
});
