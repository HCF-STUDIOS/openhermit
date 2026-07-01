import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { AgentConfig } from '../src/core/index.js';
import { resolveModel } from '../src/agent-runner/model-utils.js';
import { listProviderCatalog } from '../src/model-catalog.js';

const modelConfig = (provider: string, model: string): AgentConfig =>
  ({ model: { provider, model, max_tokens: 131072 } } as unknown as AgentConfig);

test('MiniMax-M3 resolves as a multimodal (image-capable) model', () => {
  const m = resolveModel(modelConfig('minimax', 'MiniMax-M3'));
  assert.equal(m.id, 'MiniMax-M3');
  assert.equal(m.api, 'anthropic-messages');
  assert.equal(m.baseUrl, 'https://api.minimax.io/anthropic');
  assert.equal(m.contextWindow, 1000000, 'M3 context window is 1M per MiniMax docs');
  assert.ok(
    Array.isArray(m.input) && (m.input as string[]).includes('image'),
    'M3 must accept image input or the agent downgrades attachments to text',
  );
});

test('MiniMax-M3 on the CN provider uses the minimaxi.com endpoint', () => {
  const m = resolveModel(modelConfig('minimax-cn', 'MiniMax-M3'));
  assert.equal(m.baseUrl, 'https://api.minimaxi.com/anthropic');
  assert.ok((m.input as string[]).includes('image'));
});

test('MiniMax-M3 appears in the picker catalog under minimax with the reasoning flag', () => {
  const minimax = listProviderCatalog().find((p) => p.provider === 'minimax');
  assert.ok(minimax, 'minimax provider present in catalog');
  const m3 = minimax!.models.find((m) => m.id === 'MiniMax-M3');
  assert.ok(m3, 'MiniMax-M3 listed in the catalog');
  assert.equal(m3!.reasoning, true);
});

test('MiniMax-M3 appears in the picker catalog under minimax-cn too', () => {
  const minimaxCn = listProviderCatalog().find((p) => p.provider === 'minimax-cn');
  assert.ok(minimaxCn, 'minimax-cn provider present in catalog');
  const m3 = minimaxCn!.models.find((m) => m.id === 'MiniMax-M3');
  assert.ok(m3, 'MiniMax-M3 listed under minimax-cn');
  assert.equal(m3!.reasoning, true);
});

test('MiniMax-M3 resolves under the openrouter provider (OpenAI-compatible, slashed id)', () => {
  const m = resolveModel(modelConfig('openrouter', 'minimax/minimax-m3'));
  assert.equal(m.id, 'minimax/minimax-m3');
  assert.equal(m.api, 'openai-completions');
  assert.equal(m.baseUrl, 'https://openrouter.ai/api/v1');
  assert.equal(m.contextWindow, 1000000);
  assert.ok((m.input as string[]).includes('image'), 'openrouter M3 must be image-capable');
});

test('MiniMax-M3 appears in the picker catalog under openrouter', () => {
  const openrouter = listProviderCatalog().find((p) => p.provider === 'openrouter');
  assert.ok(openrouter, 'openrouter provider present in catalog');
  const m3 = openrouter!.models.find((m) => m.id === 'minimax/minimax-m3');
  assert.ok(m3, 'minimax/minimax-m3 listed under openrouter');
  assert.equal(m3!.reasoning, true);
});

test('MiniMax-M3 is grouped next to the other minimax models under openrouter (not appended last)', () => {
  const openrouter = listProviderCatalog().find((p) => p.provider === 'openrouter');
  assert.ok(openrouter);
  const ids = openrouter!.models.map((m) => m.id);
  const idx = ids.indexOf('minimax/minimax-m3');
  assert.ok(idx > 0, 'minimax/minimax-m3 present and not first');
  // The entry immediately before it belongs to the same minimax family.
  assert.ok(
    ids[idx - 1]!.startsWith('minimax/'),
    `expected a minimax sibling before m3, got ${ids[idx - 1]}`,
  );
});

test('MiniMax-M2.7 is left untouched and stays text-only (removed only after migration)', () => {
  const m = resolveModel(modelConfig('minimax', 'MiniMax-M2.7'));
  assert.equal(m.id, 'MiniMax-M2.7');
  assert.ok(!(m.input as string[]).includes('image'), 'M2.7 is text-only');
});
