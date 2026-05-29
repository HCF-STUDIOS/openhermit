import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isProcessableMessage } from '../src/bot.js';
import type { SlackMessageEvent } from '../src/slack-api.js';

const base: SlackMessageEvent = {
  type: 'message',
  channel: 'C1',
  user: 'U1',
  text: 'hello',
  ts: '1.1',
};

test('isProcessableMessage accepts a plain text message', () => {
  assert.equal(isProcessableMessage(base), true);
});

test('isProcessableMessage accepts a file_share with files and no text', () => {
  assert.equal(
    isProcessableMessage({
      ...base,
      text: undefined,
      subtype: 'file_share',
      files: [{ id: 'F1', mimetype: 'image/png', url_private: 'https://x/y' }],
    }),
    true,
  );
});

test('isProcessableMessage drops other subtypes, bot echoes, and userless events', () => {
  assert.equal(isProcessableMessage({ ...base, subtype: 'message_changed' }), false);
  assert.equal(isProcessableMessage({ ...base, bot_id: 'B1' }), false);
  assert.equal(isProcessableMessage({ ...base, user: undefined }), false);
});

test('isProcessableMessage drops empty messages with no files', () => {
  assert.equal(isProcessableMessage({ ...base, text: undefined }), false);
  assert.equal(isProcessableMessage({ ...base, text: '', files: [] }), false);
});

test('isProcessableMessage drops whitespace-only text with no files', () => {
  assert.equal(isProcessableMessage({ ...base, text: '   \n\t ' }), false);
  // …but whitespace text alongside a file is still processable.
  assert.equal(
    isProcessableMessage({ ...base, text: '   ', files: [{ id: 'F1', url_private: 'https://x/y' }] }),
    true,
  );
});
