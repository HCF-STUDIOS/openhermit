import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildSystemPrompt } from '../src/agent-runner/prompt.js';
import type { Toolset } from '../src/tools/shared.js';
import { createSecurityFixture } from './helpers.js';

const mockToolset = (id: string, description: string): Toolset => ({
  id,
  description,
  tools: [],
});

const allToolsets: Toolset[] = [
  mockToolset('memory', '### Memory\n\nmemory_recall memory_add'),
  mockToolset('instruction', '### Instructions Management\n\ninstruction_update'),
  mockToolset('exec', '### Execution\n\nexec tool'),
  mockToolset('container', '### Containers\n\nMounting files into service containers\nmount_target\ncontainer_start'),
  mockToolset('web', '### Web\n\nweb_search web_fetch'),
];

test('buildSystemPrompt includes container mounting guidance when container tools are available', async (t) => {
  const { security } = await createSecurityFixture(t);
  await security.load();
  const config = await security.readConfig();

  const prompt = await buildSystemPrompt(config, security, allToolsets);

  assert.match(prompt, /Mounting files into service containers/);
  assert.match(prompt, /mount_target/);
});

test('buildSystemPrompt omits container section when container toolset is absent', async (t) => {
  const { security } = await createSecurityFixture(t);
  await security.load();
  const config = await security.readConfig();

  const prompt = await buildSystemPrompt(config, security, allToolsets.filter((ts) => ts.id !== 'container'));

  assert.doesNotMatch(prompt, /container_start/);
  assert.doesNotMatch(prompt, /mount_target/);
});

test('buildSystemPrompt omits memory section when memory toolset is absent', async (t) => {
  const { security } = await createSecurityFixture(t);
  await security.load();
  const config = await security.readConfig();

  const prompt = await buildSystemPrompt(config, security, allToolsets.filter((ts) => ts.id !== 'memory'));

  assert.doesNotMatch(prompt, /memory_add/);
  assert.doesNotMatch(prompt, /memory_recall/);
});

test('buildSystemPrompt includes all sections when all toolsets are present', async (t) => {
  const { security } = await createSecurityFixture(t);
  await security.load();
  const config = await security.readConfig();

  const prompt = await buildSystemPrompt(config, security, allToolsets);

  assert.match(prompt, /### Memory/);
  assert.match(prompt, /### Execution/);
  assert.match(prompt, /### Containers/);
  assert.match(prompt, /### Web/);
  assert.match(prompt, /### Instructions Management/);
});
