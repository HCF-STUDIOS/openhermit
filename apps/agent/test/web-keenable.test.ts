import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createWebProvider } from '../src/web/factory.js';
import { KeenableWebProvider } from '../src/web/providers/keenable.js';

interface Captured {
  urls: string[];
  inits: RequestInit[];
}

const stubFetch = (t: import('node:test').TestContext, payload: unknown): Captured => {
  const captured: Captured = { urls: [], inits: [] };
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    captured.urls.push(String(input));
    captured.inits.push(init ?? {});
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  return captured;
};

const headersOf = (init: RequestInit) => init.headers as Record<string, string>;

test('factory: keenable needs no key', () => {
  assert.ok(createWebProvider('keenable') instanceof KeenableWebProvider);
  assert.ok(createWebProvider('keenable', 'k') instanceof KeenableWebProvider);
});

test('keenable search: keyless uses the public endpoint with X-Keenable-Title', async (t) => {
  const captured = stubFetch(t, {
    results: [
      { title: 'A', url: 'https://a.example.com/1', snippet: 'x'.repeat(500) },
      { title: '', url: 'https://b.example.com/2', description: 'desc' },
      { title: 'no url' },
    ],
  });
  const results = await new KeenableWebProvider().search('hello', { limit: 3 });

  assert.equal(captured.urls[0], 'https://api.keenable.ai/v1/search/public');
  const init = captured.inits[0]!;
  assert.equal(init.method, 'POST');
  assert.equal(headersOf(init)['X-Keenable-Title'], 'OpenHermit');
  assert.equal(headersOf(init)['X-API-Key'], undefined);
  assert.deepEqual(JSON.parse(String(init.body)), { query: 'hello', max_results: 3 });

  assert.equal(results.length, 2);
  assert.equal(results[0]!.snippet.length, 300);
  assert.equal(results[0]!.content, undefined);
  assert.deepEqual(results[1], { title: 'https://b.example.com/2', url: 'https://b.example.com/2', snippet: 'desc' });
});

test('keenable search: keyed uses /v1/search with X-API-Key and no title header', async (t) => {
  const captured = stubFetch(t, { results: [] });
  await new KeenableWebProvider('secret').search('q');

  assert.equal(captured.urls[0], 'https://api.keenable.ai/v1/search');
  assert.equal(headersOf(captured.inits[0]!)['X-API-Key'], 'secret');
  assert.equal(headersOf(captured.inits[0]!)['X-Keenable-Title'], undefined);
});

test('keenable search: one include domain becomes site:, filters stay strict', async (t) => {
  const captured = stubFetch(t, {
    results: [
      { title: 'in', url: 'https://docs.example.com/a', snippet: 's' },
      { title: 'out', url: 'https://spam.net/b', snippet: 's' },
    ],
  });
  const results = await new KeenableWebProvider().search('q', {
    includeDomains: ['example.com'],
  });

  assert.equal(JSON.parse(String(captured.inits[0]!.body)).query, 'site:example.com q');
  assert.deepEqual(results.map((r) => r.url), ['https://docs.example.com/a']);
});

test('keenable fetch: keyless GET with encoded url, truncates to maxBytes', async (t) => {
  const captured = stubFetch(t, {
    url: 'https://example.com/',
    title: 'Example',
    content: 'abcdef',
  });
  const result = await new KeenableWebProvider().fetch('https://example.com/?a=1&b=2', {
    maxBytes: 4,
  });

  assert.equal(
    captured.urls[0],
    'https://api.keenable.ai/v1/fetch/public?url=https%3A%2F%2Fexample.com%2F%3Fa%3D1%26b%3D2',
  );
  assert.equal(captured.inits[0]!.method, 'GET');
  assert.equal(headersOf(captured.inits[0]!)['X-Keenable-Title'], 'OpenHermit');
  assert.equal(result.url, 'https://example.com/');
  assert.equal(result.title, 'Example');
  assert.equal(result.content, 'abcd');
  assert.equal(result.contentBytes, 6);
  assert.equal(result.truncated, true);
});

test('keenable: HTTP errors surface with status', async (t) => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response('slow down', { status: 429 })) as typeof fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  await assert.rejects(new KeenableWebProvider().search('q'), /Keenable search failed: HTTP 429/);
});
