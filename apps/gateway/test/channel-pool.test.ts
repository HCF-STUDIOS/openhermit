import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ChannelManifest } from '@openhermit/protocol';

import { ChannelPool, type ChannelPoolOptions } from '../src/channel-pool.js';

/**
 * Fake channel manifests whose `start()` yields (so concurrent callers can
 * interleave) and counts live bridges: +1 on start, -1 on stop. A leaked
 * poller shows up as `live > 1` for one channel, or `live > 0` after disable.
 */
const createHarness = (hooks: { afterLoadActive?: (rows: Array<Record<string, unknown>>) => void } = {}) => {
  const live = new Map<string, number>();
  const started: Array<{ key: string; token: unknown }> = [];
  const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 5));
  const manifest = (key: string): ChannelManifest =>
    ({
      key,
      namespace: key,
      start: async (_config: unknown, context: { agentTokens?: Record<string, string> }) => {
        started.push({ key, token: context.agentTokens?.[key] });
        await tick();
        live.set(key, (live.get(key) ?? 0) + 1);
        let stopped = false;
        return {
          name: key,
          stop: async () => {
            await tick();
            if (!stopped) {
              stopped = true;
              live.set(key, (live.get(key) ?? 0) - 1);
            }
          },
        };
      },
    }) as unknown as ChannelManifest;

  const manifests = new Map([['telegram', manifest('telegram')], ['slack', manifest('slack')]]);
  const rows = ['telegram', 'slack'].map((channelType) => ({
    id: `row-${channelType}`,
    agentId: 'agent-1',
    kind: 'builtin' as const,
    enabled: true,
    channelType,
    namespace: channelType,
    token: `tok-${channelType}`,
    config: {},
  }));

  const channelStore = {
    loadActive: async () => {
      await tick();
      // A snapshot, like the real store: later row changes don't reach it.
      const snapshot = rows.map((r) => ({ ...r }));
      hooks.afterLoadActive?.(rows);
      return snapshot;
    },
    findBuiltin: async (_agentId: string, name: string) => {
      await tick();
      return rows.find((r) => r.channelType === name);
    },
    recordSuccess: async () => {},
    recordError: async () => {},
    clearError: async () => {},
  };

  const opts = {
    agentStore: {},
    channelStore,
    configStore: {},
    secretStore: {},
    channelRegistry: { register: () => {}, unregister: () => {}, unregisterByAgent: () => {} },
    manifestRegistry: { get: (key: string) => manifests.get(key) },
    gatewayBaseUrl: 'http://127.0.0.1:0',
    getRunner: () => undefined,
    log: () => {},
  } as unknown as ChannelPoolOptions;

  const pool = new ChannelPool(opts);
  // Secret expansion needs a real agent record; it's irrelevant here.
  (pool as unknown as { loadSecurity: () => Promise<unknown> }).loadSecurity = async () => {
    await tick();
    return { expandSecrets: async <T>(value: T) => value };
  };
  return { pool, live, started };
};

test('ChannelPool: enable racing boot never leaves an untracked poller', async () => {
  const { pool, live } = createHarness();

  // Boot starts telegram + slack while an enable of telegram lands mid-boot.
  await Promise.all([pool.start(), pool.enableChannel('agent-1', 'telegram')]);

  assert.equal(live.get('telegram'), 1, 'exactly one telegram poller is live');
  assert.equal(live.get('slack'), 1, 'slack poller is live');
  assert.deepEqual(
    pool.getOutbounds('agent-1').map((h) => h.name).sort(),
    ['slack', 'telegram'],
    'every live poller is tracked',
  );

  await pool.stopAll();
  assert.equal(live.get('telegram'), 0, 'stopAll reaches every poller');
  assert.equal(live.get('slack'), 0);
});

test('ChannelPool: concurrent enables of the same channel run one poller', async () => {
  const { pool, live } = createHarness();

  await Promise.all([
    pool.enableChannel('agent-1', 'telegram'),
    pool.enableChannel('agent-1', 'telegram'),
    pool.enableChannel('agent-1', 'telegram'),
  ]);
  assert.equal(live.get('telegram'), 1);
  assert.equal(pool.getOutbounds('agent-1').length, 1);

  // enable + disable racing: disable is serialized after the enable, so
  // nothing is left running.
  await Promise.all([
    pool.enableChannel('agent-1', 'telegram'),
    pool.disableChannel('agent-1', 'telegram'),
  ]);
  assert.equal(live.get('telegram'), 0, 'disable stopped the poller');
  assert.equal(pool.getOutbounds('agent-1').length, 0);
});

test('ChannelPool: boot never starts a bridge from a row replaced after it was loaded', async () => {
  // The telegram row is deleted and recreated (new id, new token) right after
  // boot snapshotted the active rows, before boot takes the channel lock.
  const { pool, live, started } = createHarness({
    afterLoadActive: (rows) => {
      const telegram = rows.find((r) => r.channelType === 'telegram')!;
      telegram.id = 'row-telegram-2';
      telegram.token = 'tok-telegram-new';
    },
  });

  await pool.start();
  assert.equal(
    started.filter((s) => s.key === 'telegram').length,
    0,
    'boot skips the replaced row instead of starting it with the stale token',
  );
  assert.equal(live.get('slack'), 1, 'unchanged rows still start');

  await pool.enableChannel('agent-1', 'telegram');
  assert.deepEqual(started.filter((s) => s.key === 'telegram').map((s) => s.token), ['tok-telegram-new']);
  assert.equal(live.get('telegram'), 1);

  await pool.stopAll();
});
