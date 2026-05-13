import assert from 'node:assert/strict';
import { test } from 'node:test';

import { loadConfig } from '../src/config.js';

const withEnv = async (env: Record<string, string | undefined>, fn: () => Promise<void> | void) => {
  const prior: Record<string, string | undefined> = {};
  for (const key of Object.keys(env)) {
    prior[key] = process.env[key];
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key]!;
  }
  try {
    await fn();
  } finally {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

test('loadConfig returns parsed values when all required env vars are set', async () => {
  await withEnv(
    {
      SIGNAL_HTTP_URL: 'http://signal:8080',
      SIGNAL_ACCOUNT: '+15551234567',
      OPENHERMIT_AGENT_URL: 'http://gateway/api/agents/main',
      OPENHERMIT_AGENT_TOKEN: 'tok',
    },
    async () => {
      const cfg = await loadConfig();
      assert.equal(cfg.httpUrl, 'http://signal:8080');
      assert.equal(cfg.account, '+15551234567');
      assert.equal(cfg.agentBaseUrl, 'http://gateway/api/agents/main');
      assert.equal(cfg.agentToken, 'tok');
    },
  );
});

test('loadConfig throws when SIGNAL_HTTP_URL is missing', async () => {
  await withEnv(
    {
      SIGNAL_HTTP_URL: undefined,
      SIGNAL_ACCOUNT: '+15551234567',
      OPENHERMIT_AGENT_URL: 'http://gateway/api/agents/main',
      OPENHERMIT_AGENT_TOKEN: 'tok',
    },
    async () => {
      await assert.rejects(() => loadConfig(), /SIGNAL_HTTP_URL/);
    },
  );
});

test('loadConfig throws when SIGNAL_ACCOUNT is missing', async () => {
  await withEnv(
    {
      SIGNAL_HTTP_URL: 'http://signal:8080',
      SIGNAL_ACCOUNT: undefined,
      OPENHERMIT_AGENT_URL: 'http://gateway/api/agents/main',
      OPENHERMIT_AGENT_TOKEN: 'tok',
    },
    async () => {
      await assert.rejects(() => loadConfig(), /SIGNAL_ACCOUNT/);
    },
  );
});

test('loadConfig throws when agent URL/token are missing', async () => {
  await withEnv(
    {
      SIGNAL_HTTP_URL: 'http://signal:8080',
      SIGNAL_ACCOUNT: '+15551234567',
      OPENHERMIT_AGENT_URL: undefined,
      OPENHERMIT_AGENT_TOKEN: undefined,
    },
    async () => {
      await assert.rejects(() => loadConfig(), /OPENHERMIT_AGENT_URL/);
    },
  );
});

test('loadConfig throws when only OPENHERMIT_AGENT_TOKEN is missing', async () => {
  await withEnv(
    {
      SIGNAL_HTTP_URL: 'http://signal:8080',
      SIGNAL_ACCOUNT: '+15551234567',
      OPENHERMIT_AGENT_URL: 'http://gateway/api/agents/main',
      OPENHERMIT_AGENT_TOKEN: undefined,
    },
    async () => {
      await assert.rejects(() => loadConfig(), /OPENHERMIT_AGENT_TOKEN/);
    },
  );
});

test('loadConfig strips a trailing slash from httpUrl for predictable URL joins', async () => {
  await withEnv(
    {
      SIGNAL_HTTP_URL: 'http://signal:8080/',
      SIGNAL_ACCOUNT: '+15551234567',
      OPENHERMIT_AGENT_URL: 'http://gateway/api/agents/main',
      OPENHERMIT_AGENT_TOKEN: 'tok',
    },
    async () => {
      const cfg = await loadConfig();
      assert.equal(cfg.httpUrl, 'http://signal:8080');
    },
  );
});

test('loadConfig parses SIGNAL_ALLOWED_SENDERS and SIGNAL_ALLOWED_GROUP_IDS as trimmed comma-lists', async () => {
  await withEnv(
    {
      SIGNAL_HTTP_URL: 'http://signal:8080',
      SIGNAL_ACCOUNT: '+15551234567',
      OPENHERMIT_AGENT_URL: 'http://gateway/api/agents/main',
      OPENHERMIT_AGENT_TOKEN: 'tok',
      SIGNAL_ALLOWED_SENDERS: 'uuid:abc, +15551111111 ,',
      SIGNAL_ALLOWED_GROUP_IDS: 'gid1==,gid2==',
    },
    async () => {
      const cfg = await loadConfig();
      assert.deepEqual(cfg.allowedSenders, ['uuid:abc', '+15551111111']);
      assert.deepEqual(cfg.allowedGroupIds, ['gid1==', 'gid2==']);
    },
  );
});

test('loadConfig omits allow-list fields when env vars are unset', async () => {
  await withEnv(
    {
      SIGNAL_HTTP_URL: 'http://signal:8080',
      SIGNAL_ACCOUNT: '+15551234567',
      OPENHERMIT_AGENT_URL: 'http://gateway/api/agents/main',
      OPENHERMIT_AGENT_TOKEN: 'tok',
      SIGNAL_ALLOWED_SENDERS: undefined,
      SIGNAL_ALLOWED_GROUP_IDS: undefined,
    },
    async () => {
      const cfg = await loadConfig();
      assert.equal(cfg.allowedSenders, undefined);
      assert.equal(cfg.allowedGroupIds, undefined);
    },
  );
});
