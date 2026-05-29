import assert from 'node:assert/strict';
import { test } from 'node:test';

import { pickMediaFile } from '../src/bridge.js';
import type { TelegramMessage } from '../src/telegram-api.js';

const baseMessage = (extra: Partial<TelegramMessage>): TelegramMessage => ({
  message_id: 1,
  chat: { id: 1, type: 'private' },
  date: 0,
  ...extra,
});

test('pickMediaFile picks the largest photo size', () => {
  const media = pickMediaFile(baseMessage({
    photo: [
      { file_id: 'small', file_unique_id: 's', width: 90, height: 90, file_size: 1000 },
      { file_id: 'large', file_unique_id: 'l', width: 1280, height: 1280, file_size: 90000 },
    ],
  }));
  assert.deepEqual(media, {
    fileId: 'large',
    filename: 'photo.jpg',
    mimeType: 'image/jpeg',
    fileSize: 90000,
  });
});

test('pickMediaFile maps a document with its filename and mime', () => {
  const media = pickMediaFile(baseMessage({
    document: { file_id: 'd1', file_unique_id: 'd', file_name: 'report.pdf', mime_type: 'application/pdf', file_size: 50 },
  }));
  assert.deepEqual(media, {
    fileId: 'd1',
    filename: 'report.pdf',
    mimeType: 'application/pdf',
    fileSize: 50,
  });
});

test('pickMediaFile maps a video with fallbacks', () => {
  const media = pickMediaFile(baseMessage({
    video: { file_id: 'v1', file_unique_id: 'v', width: 640, height: 480, duration: 5 },
  }));
  assert.deepEqual(media, {
    fileId: 'v1',
    filename: 'video.mp4',
    mimeType: 'video/mp4',
  });
});

test('pickMediaFile returns undefined for a text-only message', () => {
  assert.equal(pickMediaFile(baseMessage({ text: 'hello' })), undefined);
});
