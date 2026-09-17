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

// --- Flash tier is multimodal across every alias and route ---
// The whole tier is served by the multimodal V4.1-Flash. pi-ai's registry flags
// `deepseek-v4-flash` text-only (stale) and doesn't carry `deepseek-v4.1-flash`
// at all, so without the override an amiko-routed flash agent has its images
// stripped to a text placeholder before the request.

const FLASH_ALIASES = [
  'deepseek/deepseek-v4.1-flash', // the id the amiko gateway hands out (Somiko's case)
  'deepseek/deepseek-v4-flash', // registry-served but stale text-only
  '~deepseek/deepseek-v4-flash-latest', // pin marker + -latest suffix
  'deepseek/deepseek-v4-flash-0731', // dated alias
  'deepseek/deepseek-v4-flash-vision-exp', // retired vision alias
];

for (const id of FLASH_ALIASES) {
  test(`amiko/${id} is multimodal (Flash tier served by V4.1-Flash)`, () => {
    const m = resolveModel(modelConfig('amiko', id)) as { input?: string[] };
    assert.ok(
      Array.isArray(m.input) && m.input.includes('image'),
      `${id} via amiko must accept image input, got ${JSON.stringify(m.input)}`,
    );
  });
}

test('amiko flash id unknown to the price catalog no longer records usage as $0', () => {
  // deepseek-v4.1-flash is in neither pi-ai nor the OpenRouter catalogue, so the
  // synthesize fallback used to hand back cost:0 (free forever) + a 128k window.
  const m = resolveModel(modelConfig('amiko', 'deepseek/deepseek-v4.1-flash'));
  assert.ok(m.cost.input > 0, `expected non-zero input price, got ${m.cost.input}`);
  assert.ok(m.cost.output > 0, `expected non-zero output price, got ${m.cost.output}`);
  assert.equal(m.contextWindow, 1000000, 'flash carries the real 1M window, not the 128k default');
});

test('deepseek-flash carries the compat flags even for the amiko-routed id', () => {
  // The override must not clobber the OpenRouter reasoning-format pin the amiko
  // synthesize path adds, or thoughts leak back into the reply text.
  const m = resolveModel(modelConfig('amiko', 'deepseek/deepseek-v4.1-flash')) as {
    compat?: { thinkingFormat?: string };
  };
  assert.equal(m.compat?.thinkingFormat, 'openrouter');
});

test('deepseek-v4-pro is NOT swept into the flash multimodal override', () => {
  // Only the Flash tier gained vision; Pro stays text-only. `flash\b` guards this.
  const m = resolveModel(modelConfig('amiko', 'deepseek/deepseek-v4-pro')) as { input?: string[] };
  assert.ok(
    !m.input?.includes('image'),
    `deepseek-v4-pro must stay text-only, got ${JSON.stringify(m.input)}`,
  );
});
