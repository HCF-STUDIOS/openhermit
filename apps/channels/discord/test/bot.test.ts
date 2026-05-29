import assert from 'node:assert/strict';
import { test } from 'node:test';

import { mapRawAttachments } from '../src/bot.js';

test('mapRawAttachments maps gateway-dispatch attachments to the neutral shape', () => {
  const mapped = mapRawAttachments([
    { url: 'https://cdn.discordapp.com/a.png', filename: 'a.png', content_type: 'image/png', size: 1234 },
    { url: 'https://cdn.discordapp.com/b.pdf', filename: 'b.pdf', content_type: 'application/pdf', size: 99 },
  ]);
  assert.deepEqual(mapped, [
    { url: 'https://cdn.discordapp.com/a.png', name: 'a.png', contentType: 'image/png', size: 1234 },
    { url: 'https://cdn.discordapp.com/b.pdf', name: 'b.pdf', contentType: 'application/pdf', size: 99 },
  ]);
});

test('mapRawAttachments tolerates missing fields and non-arrays', () => {
  assert.deepEqual(mapRawAttachments(undefined), []);
  assert.deepEqual(mapRawAttachments('nope'), []);
  assert.deepEqual(mapRawAttachments([{ url: 'https://x/y' }]), [
    { url: 'https://x/y', name: 'attachment' },
  ]);
  // Entries without a url are dropped.
  assert.deepEqual(mapRawAttachments([{ filename: 'no-url.txt' }]), []);
});
