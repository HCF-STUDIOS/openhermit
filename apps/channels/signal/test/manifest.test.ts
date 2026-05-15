import assert from 'node:assert/strict';
import { test } from 'node:test';

import manifest from '../src/manifest.js';

test('manifest exposes the required plugin contract', () => {
  assert.equal(manifest.manifestVersion, 1);
  assert.equal(manifest.key, 'signal');
  assert.equal(manifest.namespace, 'signal');
  assert.equal(manifest.displayName, 'Signal');
  assert.equal(typeof manifest.start, 'function');
  assert.ok(manifest.setup, 'manifest must expose ChannelSetup');
});

test('start() without required config returns undefined (channel disabled until linked)', async () => {
  const log: string[] = [];
  const handle = await manifest.start(
    { enabled: true },
    {
      agentBaseUrl: 'http://gateway/api/agents/x',
      agentTokens: { signal: 'tok' },
      logger: (_ch, msg) => log.push(msg),
    },
  );
  assert.equal(handle, undefined);
  assert.ok(
    log.some((m) => m.toLowerCase().includes('http_url')) ||
      log.some((m) => m.toLowerCase().includes('account')),
    `expected log to mention missing http_url or account, got: ${log.join(' | ')}`,
  );
});
