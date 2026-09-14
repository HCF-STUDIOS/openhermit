import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { AgentConfig } from '../src/core/index.js';
import { resolveModel } from '../src/agent-runner/model-utils.js';
import { listProviderCatalog } from '../src/model-catalog.js';

const modelConfig = (provider: string, model: string): AgentConfig =>
  ({ model: { provider, model } } as unknown as AgentConfig);

test('deepseek-flash (new canonical id) resolves against api.deepseek.com', () => {
  const m = resolveModel(modelConfig('deepseek', 'deepseek-flash'));
  assert.equal(m.id, 'deepseek-flash');
  assert.equal(m.provider, 'deepseek');
  assert.equal(m.api, 'openai-completions');
  assert.equal(m.baseUrl, 'https://api.deepseek.com');
  assert.equal(m.contextWindow, 1000000);
});

test('deepseek-flash is multimodal (V4.1-Flash added vision)', () => {
  const m = resolveModel(modelConfig('deepseek', 'deepseek-flash'));
  assert.ok(
    Array.isArray(m.input) && (m.input as string[]).includes('image'),
    'deepseek-flash must accept image input',
  );
});

test('deepseek-flash carries the deepseek reasoning compat flags', () => {
  const m = resolveModel(modelConfig('deepseek', 'deepseek-flash'));
  assert.equal(m.reasoning, true);
  const compat = (m as { compat?: Record<string, unknown> }).compat;
  assert.ok(compat, 'compat present');
  assert.equal(compat!.requiresReasoningContentOnAssistantMessages, true);
  assert.equal(compat!.thinkingFormat, 'deepseek');
});

test('deepseek-flash appears in the picker catalog under deepseek', () => {
  const deepseek = listProviderCatalog().find((p) => p.provider === 'deepseek');
  assert.ok(deepseek, 'deepseek provider present in catalog');
  const flash = deepseek!.models.find((m) => m.id === 'deepseek-flash');
  assert.ok(flash, 'deepseek-flash listed in the catalog');
  assert.equal(flash!.reasoning, true);
});

test('legacy deepseek-v4-flash still resolves (retired alias, registry-served)', () => {
  const m = resolveModel(modelConfig('deepseek', 'deepseek-v4-flash'));
  assert.equal(m.id, 'deepseek-v4-flash');
  assert.equal(m.provider, 'deepseek');
});
