import assert from 'node:assert/strict';
import { test } from 'node:test';

import { shouldAcceptMessage, type WhatsAppIncomingMessage } from '../src/bridge.js';

const base: WhatsAppIncomingMessage = {
  chatJid: '15551234567@s.whatsapp.net',
  senderJid: '15551234567@s.whatsapp.net',
  senderNumber: '+15551234567',
  text: 'hello',
  isGroup: false,
  mentioned: true,
};

test('shouldAcceptMessage accepts DMs by default', () => {
  assert.equal(shouldAcceptMessage(base, {}), true);
});

test('shouldAcceptMessage applies sender allow-list to DMs', () => {
  assert.equal(shouldAcceptMessage(base, { allowedSenders: ['+15551234567'] }), true);
  assert.equal(shouldAcceptMessage(base, { allowedSenders: ['+15550000000'] }), false);
});

test('shouldAcceptMessage denies groups unless configured', () => {
  const group: WhatsAppIncomingMessage = {
    ...base,
    chatJid: '120363@g.us',
    isGroup: true,
    mentioned: false,
  };
  assert.equal(shouldAcceptMessage(group, {}), false);
  assert.equal(shouldAcceptMessage(group, { allowedGroupJids: ['120363@g.us'] }), true);
  assert.equal(shouldAcceptMessage(group, { allowedGroupJids: ['*'] }), true);
});
