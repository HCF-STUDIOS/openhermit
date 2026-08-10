import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import type { AgentConfig } from '../src/core/index.js';
import { resolveModel } from '../src/agent-runner/model-utils.js';
import {
  clearDynamicProviderCache,
  listProviderCatalogWithDynamic,
} from '../src/model-catalog.js';

const modelConfig = (provider: string, model: string, base_url?: string): AgentConfig =>
  ({ model: { provider, model, ...(base_url ? { base_url } : {}) } } as unknown as AgentConfig);

// --- resolveModel: amiko provider ---

test('amiko resolves as OpenAI-compatible against the router without explicit base_url', () => {
  const m = resolveModel(modelConfig('amiko', 'google/gemini-3.1-flash-lite-preview'));
  assert.equal(m.api, 'openai-completions');
  assert.equal(m.baseUrl, 'https://api.heyamiko.com/api/v1');
  assert.equal(m.provider, 'amiko');
});

test('amiko models borrow OpenRouter list pricing so usage cost is not $0', () => {
  const m = resolveModel(modelConfig('amiko', 'google/gemini-3.1-flash-lite-preview'));
  assert.ok(m.cost.input > 0, `expected non-zero input price, got ${m.cost.input}`);
  assert.ok(m.cost.output > 0, `expected non-zero output price, got ${m.cost.output}`);
  assert.ok(
    m.contextWindow > 128000,
    `expected borrowed context window, got default ${m.contextWindow}`,
  );
});

test('amiko dated model ids fall back to the undated OpenRouter registry entry', () => {
  const m = resolveModel(
    modelConfig('amiko', 'google/gemini-3.1-flash-lite-preview-20991231'),
  );
  assert.equal(m.id, 'google/gemini-3.1-flash-lite-preview-20991231');
  assert.ok(m.cost.input > 0, 'dated id should borrow pricing from the undated entry');
});

test('amiko models unknown to OpenRouter still resolve, with zero-cost fallback', () => {
  const m = resolveModel(modelConfig('amiko', 'amiko/definitely-not-a-real-model'));
  assert.equal(m.api, 'openai-completions');
  assert.deepEqual(m.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  assert.equal(m.contextWindow, 128000);
});

test('AMIKO_BASE_URL steers resolveModel to the same host as the catalog', () => {
  process.env.AMIKO_BASE_URL = 'http://localhost:4141/api/v1';
  try {
    const m = resolveModel(modelConfig('amiko', 'google/gemini-3.1-flash-lite-preview'));
    assert.equal(m.baseUrl, 'http://localhost:4141/api/v1');
  } finally {
    if (originalBaseUrl === undefined) delete process.env.AMIKO_BASE_URL;
    else process.env.AMIKO_BASE_URL = originalBaseUrl;
  }
});

test('per-agent base_url override still wins over the amiko default', () => {
  const m = resolveModel(
    modelConfig('amiko', 'google/gemini-3.1-flash-lite-preview', 'http://localhost:9999/v1'),
  );
  assert.equal(m.baseUrl, 'http://localhost:9999/v1');
  assert.ok(m.cost.input > 0, 'pricing borrow keys off the provider, not the base_url');
});

test('arbitrary custom providers do not borrow OpenRouter pricing', () => {
  const m = resolveModel(
    ({
      model: {
        provider: 'my-vllm',
        model: 'google/gemini-3.1-flash-lite-preview',
        api: 'openai-completions',
        base_url: 'http://localhost:8000/v1',
      },
    } as unknown) as AgentConfig,
  );
  assert.deepEqual(m.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
});

// --- dynamic catalog ---

const ROUTER_MODELS_BODY = {
  data: [
    {
      id: 'google/gemini-3.1-flash-lite-preview',
      supported_parameters: ['tools', 'reasoning'],
    },
    { id: 'openai/gpt-5.2', supported_parameters: ['tools'] },
    { id: '' }, // malformed entries are dropped, not crashed on
  ],
};

const originalFetch = globalThis.fetch;
const originalApiKey = process.env.AMIKO_API_KEY;
const originalBaseUrl = process.env.AMIKO_BASE_URL;

beforeEach(() => {
  clearDynamicProviderCache();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalApiKey === undefined) delete process.env.AMIKO_API_KEY;
  else process.env.AMIKO_API_KEY = originalApiKey;
  if (originalBaseUrl === undefined) delete process.env.AMIKO_BASE_URL;
  else process.env.AMIKO_BASE_URL = originalBaseUrl;
  clearDynamicProviderCache();
});

test('catalog fetches amiko anonymously when AMIKO_API_KEY is unset', async () => {
  delete process.env.AMIKO_API_KEY;
  const auths: (string | null)[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    auths.push(new Headers(init?.headers).get('authorization'));
    return new Response(JSON.stringify(ROUTER_MODELS_BODY));
  }) as typeof fetch;

  const catalog = await listProviderCatalogWithDynamic();
  assert.ok(
    catalog.some((p) => p.provider === 'amiko'),
    'public /models -> amiko listed without a key',
  );
  assert.deepEqual(auths, [null], 'no key -> anonymous request, no auth header');
});

test('keyless catalog omits amiko while the router still requires auth on /models', async () => {
  delete process.env.AMIKO_API_KEY;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 })) as typeof fetch;

  const catalog = await listProviderCatalogWithDynamic();
  assert.ok(!catalog.some((p) => p.provider === 'amiko'));
});

test('catalog includes amiko models from the router, sorted first, reasoning mapped', async () => {
  process.env.AMIKO_API_KEY = 'amk_test';
  const requests: { url: string; auth: string | null }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    requests.push({ url: String(input), auth: headers.get('authorization') });
    return new Response(JSON.stringify(ROUTER_MODELS_BODY));
  }) as typeof fetch;

  const catalog = await listProviderCatalogWithDynamic();
  const amiko = catalog.find((p) => p.provider === 'amiko');
  assert.ok(amiko, 'amiko provider present');
  // 'amiko' > 'amazon-bedrock' ('i' vs 'a' at index 2) but < 'anthropic'.
  assert.equal(catalog[0]!.provider, 'amazon-bedrock');
  assert.equal(catalog.indexOf(amiko!), 1, 'amiko sorts between amazon-bedrock and anthropic');
  assert.deepEqual(amiko!.models, [
    { id: 'google/gemini-3.1-flash-lite-preview', reasoning: true },
    { id: 'openai/gpt-5.2', reasoning: false },
  ]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.url, 'https://api.heyamiko.com/api/v1/models');
  assert.equal(requests[0]!.auth, 'Bearer amk_test');
});

test('router model list is cached across catalog calls', async () => {
  process.env.AMIKO_API_KEY = 'amk_test';
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return new Response(JSON.stringify(ROUTER_MODELS_BODY));
  }) as typeof fetch;

  await listProviderCatalogWithDynamic();
  await listProviderCatalogWithDynamic();
  assert.equal(calls, 1, 'second call served from cache');
});

test('router failure degrades to the static catalog instead of breaking the picker', async () => {
  process.env.AMIKO_API_KEY = 'amk_test';
  globalThis.fetch = (async () => {
    throw new Error('boom');
  }) as typeof fetch;

  const catalog = await listProviderCatalogWithDynamic();
  assert.ok(!catalog.some((p) => p.provider === 'amiko'));
  assert.ok(
    catalog.some((p) => p.provider === 'openrouter'),
    'static catalog still served',
  );
});

test('AMIKO_BASE_URL overrides the router endpoint', async () => {
  process.env.AMIKO_API_KEY = 'amk_test';
  process.env.AMIKO_BASE_URL = 'http://localhost:4141/api/v1';
  const urls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    urls.push(String(input));
    return new Response(JSON.stringify(ROUTER_MODELS_BODY));
  }) as typeof fetch;

  await listProviderCatalogWithDynamic();
  assert.deepEqual(urls, ['http://localhost:4141/api/v1/models']);
});

// --- image modality ---

test('amiko-routed models report image input, so doc_read sends image blocks', () => {
  // doc_read routes on modelSupportsImageInput, which agent-runner derives from
  // resolveModel(...).input. Lose the modality and every image silently OCRs.
  for (const id of [
    'google/gemini-3.1-flash-lite-preview',
    'google/gemini-3-flash-preview',
    'anthropic/claude-sonnet-4.5',
  ]) {
    const amiko = resolveModel(modelConfig('amiko', id)) as { input?: string[] };
    const openrouter = resolveModel(modelConfig('openrouter', id)) as { input?: string[] };
    assert.deepEqual(
      amiko.input,
      openrouter.input,
      `amiko must borrow ${id}'s modalities from the openrouter catalogue`,
    );
    assert.ok(amiko.input?.includes('image'), `${id} via amiko should accept images`);
  }
});

test('a text-only model routed through amiko still resolves as text-only', () => {
  // The other half: doc_read must OCR rather than ship blocks this model can't read.
  const m = resolveModel(modelConfig('amiko', 'openai/gpt-oss-120b')) as { input?: string[] };
  assert.deepEqual(m.input, ['text']);
});
