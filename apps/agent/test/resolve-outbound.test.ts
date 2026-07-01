import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ChannelOutbound, OutboundSession } from '@openhermit/protocol';
import { resolveOutbound } from '../src/tools/session.js';

/** Fake adapter that resolves the recipient from a given metadata key. */
const adapterFor = (channel: string, key?: string): ChannelOutbound => ({
  channel,
  send: async () => ({ success: true }),
  ...(key
    ? {
        resolveRecipient(session: OutboundSession): string | undefined {
          const v = session.metadata?.[key];
          return typeof v === 'string' && v ? v : undefined;
        },
      }
    : {}),
});

const map = (...adapters: ChannelOutbound[]): Map<string, ChannelOutbound> =>
  new Map(adapters.map((a) => [a.channel, a]));

test('resolveOutbound uses the channel resolveRecipient hook', () => {
  const out = resolveOutbound(
    { source: { platform: 'wechat' }, metadata: { wechat_peer_id: 'wxid_abc' } },
    map(adapterFor('wechat', 'wechat_peer_id')),
  );
  assert.ok(out);
  assert.equal(out!.to, 'wxid_abc');
});

test('resolveOutbound returns undefined when the hook finds no recipient', () => {
  const out = resolveOutbound(
    { source: { platform: 'wechat' }, metadata: {} },
    map(adapterFor('wechat', 'wechat_peer_id')),
  );
  assert.equal(out, undefined);
});

test('resolveOutbound returns undefined when no adapter is registered for the platform', () => {
  const out = resolveOutbound(
    { source: { platform: 'amiko' }, metadata: { x: 'y' } },
    map(adapterFor('wechat', 'wechat_peer_id')),
  );
  assert.equal(out, undefined);
});

test('resolveOutbound falls back to telegram_chat_id for a hook-less adapter', () => {
  const out = resolveOutbound(
    { source: { platform: 'telegram' }, metadata: { telegram_chat_id: '12345' } },
    map(adapterFor('telegram')), // no resolveRecipient
  );
  assert.ok(out);
  assert.equal(out!.to, '12345');
});

test('resolveOutbound returns undefined for a session with no platform', () => {
  assert.equal(resolveOutbound({ source: {} }, map(adapterFor('telegram'))), undefined);
});
