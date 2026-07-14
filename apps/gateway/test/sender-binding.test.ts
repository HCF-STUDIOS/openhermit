import assert from 'node:assert/strict';
import { test } from 'node:test';

import { bindSenderIdentity } from '../src/app.js';

const userAuth = { mode: 'user' as const, channel: 'web', channelUserId: 'guest-fingerprint' };

test('user mode coerces a spoofed sender to the authenticated caller', () => {
  // An authenticated guest tries to speak as the owner on another channel.
  const bound = bindSenderIdentity(userAuth, { channel: 'lark', channelUserId: 'owner-open-id' });
  assert.deepEqual(bound, { channel: 'web', channelUserId: 'guest-fingerprint' });
});

test('user mode binds identity even when the request omits a sender', () => {
  // Closes the omitted-sender fallback to shared session state.
  const bound = bindSenderIdentity(userAuth, undefined);
  assert.deepEqual(bound, { channel: 'web', channelUserId: 'guest-fingerprint' });
});

test('user mode preserves a display name while overriding identity', () => {
  const bound = bindSenderIdentity(userAuth, {
    channel: 'lark',
    channelUserId: 'owner-open-id',
    displayName: 'Ayush',
  });
  assert.deepEqual(bound, {
    channel: 'web',
    channelUserId: 'guest-fingerprint',
    displayName: 'Ayush',
  });
});

test('user mode posting the caller own identity is unchanged', () => {
  const bound = bindSenderIdentity(userAuth, { channel: 'web', channelUserId: 'guest-fingerprint' });
  assert.deepEqual(bound, { channel: 'web', channelUserId: 'guest-fingerprint' });
});

test('channel mode passes the declared sender through (namespace check governs it)', () => {
  const channelAuth = { mode: 'channel' as const, channel: 'lark', channelUserId: '' };
  const sender = { channel: 'lark', channelUserId: 'ou_someone' };
  assert.equal(bindSenderIdentity(channelAuth, sender), sender);
});

test('admin mode passes the declared sender through', () => {
  const adminAuth = { mode: 'admin' as const, channel: 'admin', channelUserId: 'admin' };
  const sender = { channel: 'cli', channelUserId: 'local' };
  assert.equal(bindSenderIdentity(adminAuth, sender), sender);
});
