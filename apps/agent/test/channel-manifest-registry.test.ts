import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ChannelManifestRegistry,
  type ChannelContext,
  type ChannelHandle,
  type ChannelManifest,
} from '@openhermit/protocol';

const dummyContext: ChannelContext = {
  agentBaseUrl: 'http://localhost:0',
  agentTokens: {},
  logger: () => {},
};

const dummyHandle: ChannelHandle = {
  name: 'dummy',
  stop: async () => {},
};

const manifest = (key: string, overrides: Partial<ChannelManifest> = {}): ChannelManifest => ({
  key,
  namespace: key,
  displayName: key,
  start: async () => dummyHandle,
  ...overrides,
});

test('ChannelManifestRegistry: register + get + has', () => {
  const reg = new ChannelManifestRegistry();
  reg.register(manifest('telegram'));

  assert.equal(reg.has('telegram'), true);
  assert.equal(reg.has('signal'), false);
  assert.equal(reg.get('telegram')?.displayName, 'telegram');
  assert.equal(reg.get('signal'), undefined);
});

test('ChannelManifestRegistry: all() + keys() preserve insertion order', () => {
  const reg = new ChannelManifestRegistry();
  reg.register(manifest('telegram'));
  reg.register(manifest('slack'));
  reg.register(manifest('discord'));

  assert.deepEqual(reg.keys(), ['telegram', 'slack', 'discord']);
  assert.deepEqual(
    reg.all().map((m) => m.key),
    ['telegram', 'slack', 'discord'],
  );
});

test('ChannelManifestRegistry: register() throws on duplicate key', () => {
  const reg = new ChannelManifestRegistry();
  reg.register(manifest('telegram'));

  assert.throws(() => reg.register(manifest('telegram')), /duplicate channel key/);
});

test('ChannelManifestRegistry: register() rejects empty key', () => {
  const reg = new ChannelManifestRegistry();
  assert.throws(() => reg.register(manifest('')), /manifest\.key is required/);
});

test('ChannelManifestRegistry: replace() overrides existing manifest', () => {
  const reg = new ChannelManifestRegistry();
  reg.register(manifest('telegram', { displayName: 'original' }));
  reg.replace(manifest('telegram', { displayName: 'overridden' }));

  assert.equal(reg.get('telegram')?.displayName, 'overridden');
  // replace() must not duplicate
  assert.equal(reg.keys().length, 1);
});

test('ChannelManifestRegistry: replace() adds when absent', () => {
  const reg = new ChannelManifestRegistry();
  reg.replace(manifest('signal'));

  assert.equal(reg.has('signal'), true);
});

test('ChannelManifest.start: contract returns a usable handle', async () => {
  const reg = new ChannelManifestRegistry();
  let started = false;
  reg.register(
    manifest('telegram', {
      start: async (_config, _ctx) => {
        started = true;
        return dummyHandle;
      },
    }),
  );

  const m = reg.get('telegram');
  assert.ok(m);
  const handle = await m.start({}, dummyContext);
  assert.equal(started, true);
  assert.equal(handle?.name, 'dummy');
});

test('ChannelManifest.parseConfig: when set, runs before start (caller-driven)', () => {
  // The registry itself does not call parseConfig — the loader does.
  // This test pins the contract so future loader changes stay aligned.
  const m = manifest('signal', {
    parseConfig: (input) => {
      if (typeof input !== 'object' || input === null) {
        throw new Error('config must be an object');
      }
      return input;
    },
  });

  assert.throws(() => m.parseConfig!('not-an-object'), /must be an object/);
  assert.deepEqual(m.parseConfig!({ ok: true }), { ok: true });
});
