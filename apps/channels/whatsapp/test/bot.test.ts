import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  extractMedia,
  extractMentionedJids,
  extractText,
  isBotMentioned,
  toIncomingMessage,
} from '../src/bot.js';

test('extractText reads plain and caption text', () => {
  assert.equal(extractText({ message: { conversation: 'hello' } }), 'hello');
  assert.equal(extractText({ message: { imageMessage: { caption: 'photo caption' } } }), 'photo caption');
});

test('extractMentionedJids reads extended message context', () => {
  const mentions = extractMentionedJids({
    message: {
      extendedTextMessage: {
        text: '@15551234567 hi',
        contextInfo: { mentionedJid: ['15551234567@s.whatsapp.net'] },
      },
    },
  });
  assert.deepEqual(mentions, ['15551234567@s.whatsapp.net']);
});

test('isBotMentioned supports structured mentions and text fallback', () => {
  assert.equal(
    isBotMentioned({
      message: {
        extendedTextMessage: {
          text: '@15551234567 hi',
          contextInfo: { mentionedJid: ['15551234567@s.whatsapp.net'] },
        },
      },
    }, '15551234567@s.whatsapp.net', '@15551234567 hi'),
    true,
  );
  assert.equal(
    isBotMentioned({ message: { conversation: '@15551234567 hi' } }, '15551234567@s.whatsapp.net', '@15551234567 hi'),
    true,
  );
  assert.equal(
    isBotMentioned({ message: { conversation: '@155512345678 hi' } }, '15551234567@s.whatsapp.net', '@155512345678 hi'),
    false,
  );
  assert.equal(
    isBotMentioned({ message: { conversation: 'hey @15551234567 there' } }, '15551234567@s.whatsapp.net', 'hey @15551234567 there'),
    true,
  );
});

test('toIncomingMessage drops self and broadcast messages', () => {
  assert.equal(toIncomingMessage({ key: { fromMe: true } }, '1555@s.whatsapp.net'), undefined);
  assert.equal(
    toIncomingMessage({
      key: { remoteJid: 'status@broadcast' },
      message: { conversation: 'hello' },
    }, '1555@s.whatsapp.net'),
    undefined,
  );
});

test('extractMedia detects image, video, voice, and document nodes', () => {
  assert.deepEqual(extractMedia({ message: { imageMessage: { mimetype: 'image/png' } } }), {
    kind: 'image',
    mimeType: 'image/png',
    filename: 'image.png',
    isVoice: false,
  });
  assert.deepEqual(extractMedia({ message: { videoMessage: { mimetype: 'video/mp4' } } }), {
    kind: 'video',
    mimeType: 'video/mp4',
    filename: 'video.mp4',
    isVoice: false,
  });
  assert.deepEqual(extractMedia({ message: { audioMessage: { mimetype: 'audio/ogg', ptt: true } } }), {
    kind: 'audio',
    mimeType: 'audio/ogg',
    filename: 'audio.ogg',
    isVoice: true,
  });
  assert.deepEqual(
    extractMedia({ message: { documentMessage: { mimetype: 'application/pdf', fileName: 'report.pdf' } } }),
    { kind: 'document', mimeType: 'application/pdf', filename: 'report.pdf', isVoice: false },
  );
  assert.equal(extractMedia({ message: { conversation: 'hi' } }), undefined);
});

test('toIncomingMessage forwards a media-only message with empty text', () => {
  const event = toIncomingMessage({
    key: { id: 'm1', remoteJid: '15551234567@s.whatsapp.net' },
    message: { imageMessage: { mimetype: 'image/jpeg' } },
  }, '1555@s.whatsapp.net');

  assert.ok(event);
  assert.equal(event.text, '');
  assert.equal(event.mentioned, true);
  assert.deepEqual(event.media, {
    kind: 'image',
    mimeType: 'image/jpeg',
    filename: 'image.jpeg',
    isVoice: false,
  });
});

test('toIncomingMessage attaches media alongside a caption', () => {
  const event = toIncomingMessage({
    key: { id: 'm2', remoteJid: '15551234567@s.whatsapp.net' },
    message: { imageMessage: { mimetype: 'image/jpeg', caption: 'look at this' } },
  }, '1555@s.whatsapp.net');

  assert.ok(event);
  assert.equal(event.text, 'look at this');
  assert.equal(event.media?.kind, 'image');
});

test('toIncomingMessage builds group event with mention state', () => {
  const event = toIncomingMessage({
    key: {
      id: 'm1',
      remoteJid: '120363@g.us',
      participant: '15550000000@s.whatsapp.net',
    },
    pushName: 'Alice',
    message: {
      extendedTextMessage: {
        text: '@15551234567 hi',
        contextInfo: { mentionedJid: ['15551234567@s.whatsapp.net'] },
      },
    },
  }, '15551234567@s.whatsapp.net');

  assert.ok(event);
  assert.equal(event.isGroup, true);
  assert.equal(event.mentioned, true);
  assert.equal(event.senderNumber, '+15550000000');
  assert.equal(event.senderName, 'Alice');
});
