import assert from 'node:assert/strict';
import { test } from 'node:test';

import { NotFoundError } from '@openhermit/shared';

import { createSecurityFixture } from './helpers.js';

test('AgentSecurity loads the default policy', async (t) => {
  const { security } = await createSecurityFixture(t);

  await security.load();

  assert.equal(security.getAccessLevel(), 'public');
  assert.deepEqual(security.listSecretNames(), []);
});

test('AgentSecurity resolves configured secrets', async (t) => {
  const { security } = await createSecurityFixture(t, {
    secrets: {
      ANTHROPIC_API_KEY: 'secret-key',
      TELEGRAM_BOT_TOKEN: 'bot-token',
    },
  });

  await security.load();

  assert.deepEqual(security.listSecretNames(), [
    'ANTHROPIC_API_KEY',
    'TELEGRAM_BOT_TOKEN',
  ]);
  assert.deepEqual(security.resolveSecrets(['ANTHROPIC_API_KEY']), {
    ANTHROPIC_API_KEY: 'secret-key',
  });
  assert.throws(
    () => security.resolveSecrets(['MISSING_SECRET']),
    NotFoundError,
  );
});

test('AgentSecurity loads policy with legacy autonomy_level gracefully', async (t) => {
  const { security, configStore, agentId } = await createSecurityFixture(t);

  await configStore.setSecurity(agentId, {
    autonomy_level: 'readonly',
    require_approval_for: ['exec'],
  });

  await security.load();
  assert.equal(security.getAccessLevel(), 'public');
});

test('AgentSecurity scaffolds and reads the default runtime config', async (t) => {
  const { security, root } = await createSecurityFixture(t);

  const config = await security.readConfig();

  assert.equal(config.workspace_root, root);
  assert.equal(config.model.provider, 'openrouter');
  assert.ok(config.exec, 'exec config should be populated by default');
  assert.equal(config.web?.provider, 'defuddle');
  assert.equal(config.memory.introspection?.enabled, true);
});

test('AgentSecurity accepts Tenki backend config', async (t) => {
  const { security } = await createSecurityFixture(t);
  const config = await security.readRawConfig();

  await security.writeConfig({
    ...config,
    exec: {
      backends: [{
        type: 'tenki',
        cpu_cores: 2,
        memory_mb: 4096,
        disk_size_gb: 10,
        agent_home: '/home/tenki',
      }],
      default_backend: 'tenki',
    },
  });

  const parsed = await security.readConfig();
  assert.equal(parsed.exec?.backends[0]?.type, 'tenki');
});

test('AgentSecurity readConfig fails clearly when DB has no config', async (t) => {
  const { security } = await createSecurityFixture(t, { skipConfig: true });
  await assert.rejects(
    () => security.readConfig(),
    /Agent config missing/i,
  );
});

test('AgentSecurity writeConfig persists into the config store', async (t) => {
  const { security, configStore, agentId } = await createSecurityFixture(t);
  const config = await security.readRawConfig();
  await security.writeConfig({ ...config, model: { ...config.model, max_tokens: 4096 } });
  const stored = await configStore.getConfig(agentId);
  assert.equal((stored as any).model.max_tokens, 4096);
});

test('AgentSecurity readSecurityPolicy / writeSecurityPolicy round-trip', async (t) => {
  const { security } = await createSecurityFixture(t);
  const policy = await security.readSecurityPolicy();
  assert.equal(typeof policy, 'object');

  await security.writeSecurityPolicy({
    access: 'private',
  });
  const updated = await security.readSecurityPolicy();
  assert.equal(updated.access, 'private');
});
