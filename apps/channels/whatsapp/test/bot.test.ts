import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
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
