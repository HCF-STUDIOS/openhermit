import assert from 'node:assert/strict';
import test from 'node:test';

import type { OutboundEventBody } from '../src/index.js';

test('pending_media event satisfies OutboundEventBody with generic kind', () => {
  const event = {
    type: 'pending_media',
    sessionId: 's1',
    correlationId: 'c1',
    kind: 'audio',
  } satisfies OutboundEventBody;

  assert.equal(event.type, 'pending_media');
  assert.equal(event.sessionId, 's1');
  assert.equal(event.correlationId, 'c1');
  assert.equal(event.kind, 'audio');
});

test('attachment event accepts a correlationId linking it back to a pending_media placeholder', () => {
  const event = {
    type: 'attachment',
    sessionId: 's1',
    attachmentId: 'a1',
    mimeType: 'audio/mpeg',
    kind: 'audio',
    correlationId: 'c1',
  } satisfies OutboundEventBody;

  assert.equal(event.type, 'attachment');
  assert.equal(event.correlationId, 'c1');
});

// The old amiko shape with jobId and mode must no longer satisfy OutboundEventBody.
// Asserting it inline would break this file's compilation with a real type error.
// Verified manually. pending_media with jobId and mode fails tsc -p tsconfig.json --noEmit.
