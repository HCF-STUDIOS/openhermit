import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  cleanBotCommandText,
  conversationKey,
  generateSessionId,
  groupAllowed,
  isBroadcastJid,
  jidToPhone,
  normalizeJid,
  phoneToJid,
  senderAllowed,
  targetToJid,
} from '../src/jid.js';

test('normalizeJid strips device suffixes before the domain', () => {
  assert.equal(
    normalizeJid('15551234567:12@s.whatsapp.net'),
    '15551234567@s.whatsapp.net',
  );
});

test('phone and target helpers normalize E.164 direct chats', () => {
  assert.equal(phoneToJid('+15551234567'), '15551234567@s.whatsapp.net');
  assert.equal(targetToJid('whatsapp:+15551234567'), '15551234567@s.whatsapp.net');
  assert.equal(jidToPhone('15551234567@s.whatsapp.net'), '+15551234567');
});

test('conversationKey separates DMs and groups', () => {
  assert.equal(conversationKey('15551234567@s.whatsapp.net'), 'whatsapp:+15551234567');
  assert.equal(
    conversationKey('120363000000000000@g.us'),
    'whatsapp:group:120363000000000000@g.us',
  );
});

test('generateSessionId uses WhatsApp prefixes', () => {
  assert.match(generateSessionId(), /^whatsapp:\d{4}-\d{2}-\d{2}-[0-9a-f]{8}$/);
  assert.match(generateSessionId(true), /^whatsapp:group:\d{4}-\d{2}-\d{2}-[0-9a-f]{8}$/);
});

test('sender allow-list accepts phone or raw jid', () => {
  assert.equal(senderAllowed('15551234567@s.whatsapp.net', undefined), true);
  assert.equal(senderAllowed('15551234567@s.whatsapp.net', ['+15551234567']), true);
  assert.equal(senderAllowed('15551234567@s.whatsapp.net', ['15551234567@s.whatsapp.net']), true);
  assert.equal(senderAllowed('15551234567@s.whatsapp.net', ['+15550000000']), false);
});

test('group allow-list is default-deny and supports wildcard', () => {
  assert.equal(groupAllowed('120363@g.us', undefined), false);
  assert.equal(groupAllowed('120363@g.us', []), false);
  assert.equal(groupAllowed('120363@g.us', ['*']), true);
  assert.equal(groupAllowed('120363@g.us', ['120363@g.us']), true);
});

test('broadcast chats are skipped', () => {
  assert.equal(isBroadcastJid('status@broadcast'), true);
  assert.equal(isBroadcastJid('abc@broadcast'), true);
  assert.equal(isBroadcastJid('15551234567@s.whatsapp.net'), false);
});

test('cleanBotCommandText removes mention token for command parsing', () => {
  assert.equal(
    cleanBotCommandText('@15551234567 /new', '15551234567@s.whatsapp.net'),
    '/new',
  );
});
