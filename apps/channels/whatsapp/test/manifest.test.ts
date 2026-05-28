import assert from 'node:assert/strict';
import { test } from 'node:test';

import manifest from '../src/manifest.js';

test('manifest exposes the required plugin contract', () => {
  assert.equal(manifest.manifestVersion, 1);
  assert.equal(manifest.key, 'whatsapp');
  assert.equal(manifest.namespace, 'whatsapp');
  assert.equal(manifest.displayName, 'WhatsApp');
  assert.equal(typeof manifest.start, 'function');
  assert.ok(manifest.setup, 'manifest must expose ChannelSetup');
});

test('start() without auth_dir returns undefined', async () => {
  const log: string[] = [];
  const handle = await manifest.start(
    { enabled: true },
    {
      agentBaseUrl: 'http://gateway/api/agents/x',
      publicAgentBaseUrl: 'http://gateway/api/agents/x',
      agentTokens: { whatsapp: 'tok' },
      logger: (_ch, msg) => log.push(msg),
      reportRuntimeError: () => undefined,
    },
  );
  assert.equal(handle, undefined);
  assert.ok(log.some((m) => m.includes('auth_dir')));
});
