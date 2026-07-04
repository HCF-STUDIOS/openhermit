import assert from 'node:assert/strict';
import test from 'node:test';

import type { OutboundEventBody } from '../src/index.js';

test('pending_media event satisfies OutboundEventBody', () => {
  const event = {
    type: 'pending_media',
    sessionId: 's1',
    jobId: 'j1',
    mode: 'MUSIC',
  } satisfies OutboundEventBody;

  assert.equal(event.type, 'pending_media');
  assert.equal(event.sessionId, 's1');
  assert.equal(event.jobId, 'j1');
  assert.equal(event.mode, 'MUSIC');
});
