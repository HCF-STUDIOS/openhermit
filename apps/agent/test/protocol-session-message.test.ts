import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isSessionMessage } from '@openhermit/protocol';

test('isSessionMessage accepts an attachment with null sandboxPath (failed materialization)', () => {
  const msg = {
    text: 'hi',
    attachments: [
      {
        id: 'att_abc',
        type: 'file',
        name: 'pic.png',
        mimeType: 'image/png',
        size: 1234,
        sha256: 'deadbeef',
        sandboxPath: null,
        materializationState: 'failed',
        materializationError: 'sandbox unavailable',
      },
    ],
  };
  assert.equal(isSessionMessage(msg), true);
});

test('isSessionMessage accepts the happy-path "copied" wire shape', () => {
  const msg = {
    text: 'check this out',
    attachments: [
      {
        id: 'att_xyz',
        type: 'file',
        name: 'pic.png',
        mimeType: 'image/png',
        size: 4096,
        sha256: 'beef',
        sandboxPath: '/sandbox/.openhermit/attachments/s1/att_xyz/pic.png',
        materializationState: 'copied',
      },
    ],
  };
  assert.equal(isSessionMessage(msg), true);
});

test('isSessionMessage still rejects an attachment with a non-string id', () => {
  const msg = {
    text: 'hi',
    attachments: [{ id: 123, type: 'file' }],
  };
  assert.equal(isSessionMessage(msg), false);
});

test('isSessionMessage still rejects an attachment missing type', () => {
  const msg = {
    text: 'hi',
    attachments: [{ id: 'att_x', name: 'pic.png' }],
  };
  assert.equal(isSessionMessage(msg), false);
});
