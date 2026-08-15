import assert from 'node:assert/strict';
import { test } from 'node:test';

import { UnauthorizedError } from '@openhermit/shared';

import { enforceSenderIdentity, type AuthContext } from '../src/auth.js';

const user = (channel: string, channelUserId: string): AuthContext => ({
  mode: 'user',
  channel,
  channelUserId,
});
const channel = (namespace: string | undefined): AuthContext => ({
  mode: 'channel',
  channel: namespace ?? 'chan',
  channelUserId: 'chan',
  ...(namespace ? { channelNamespace: namespace } : {}),
});
const admin: AuthContext = { mode: 'admin', channel: 'admin', channelUserId: 'admin' };

test('no sender is always allowed', () => {
  assert.doesNotThrow(() => enforceSenderIdentity(user('web', 'w1'), undefined));
  assert.doesNotThrow(() => enforceSenderIdentity(channel('telegram'), undefined));
});

test('admin may assert any sender', () => {
  assert.doesNotThrow(() =>
    enforceSenderIdentity(admin, { channel: 'cli', channelUserId: 'root' }),
  );
});

test('user token may only send as its own identity', () => {
  const auth = user('web', 'w1');
  assert.doesNotThrow(() =>
    enforceSenderIdentity(auth, { channel: 'web', channelUserId: 'w1' }),
  );
});

test('EXPLOIT: user token forging cli:root to become owner is rejected', () => {
  const auth = user('web', 'attacker-guest');
  assert.throws(
    () => enforceSenderIdentity(auth, { channel: 'cli', channelUserId: 'root' }),
    UnauthorizedError,
  );
});

test('user token asserting a different channelUserId in its own channel is rejected', () => {
  const auth = user('web', 'w1');
  assert.throws(
    () => enforceSenderIdentity(auth, { channel: 'web', channelUserId: 'someone-else' }),
    UnauthorizedError,
  );
});

test('channel token may assert identities within its own namespace', () => {
  assert.doesNotThrow(() =>
    enforceSenderIdentity(channel('telegram'), { channel: 'telegram', channelUserId: '12345' }),
  );
});

test('channel token cannot assert an identity in a different channel', () => {
  assert.throws(
    () => enforceSenderIdentity(channel('telegram'), { channel: 'cli', channelUserId: 'root' }),
    UnauthorizedError,
  );
});

test('channel token without a namespace fails closed', () => {
  assert.throws(
    () => enforceSenderIdentity(channel(undefined), { channel: 'telegram', channelUserId: '1' }),
    UnauthorizedError,
  );
});
