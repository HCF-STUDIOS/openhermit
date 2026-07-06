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

test('isPublishableOutboundEvent still rejects a runtime-internal type like text_delta', () => {
  assert.equal(
    isPublishableOutboundEvent({ type: 'text_delta', sessionId: 's1', text: 'hi' }),
    false,
  );
});
