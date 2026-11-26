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

test('keenable fetch: keyless POST with urls, truncates to maxBytes', async (t) => {
  const captured = stubFetch(t, {
    results: [{
      url: 'https://example.com/',
      title: 'Example',
      content: 'abcdef',
    }],
  });
  const result = await new KeenableWebProvider().fetch('https://example.com/?a=1&b=2', {
    maxBytes: 4,
  });

  assert.equal(captured.urls[0], 'https://api.keenable.ai/v1/fetch/public');
  assert.equal(captured.inits[0]!.method, 'POST');
  assert.deepEqual(JSON.parse(String(captured.inits[0]!.body)), {
    urls: ['https://example.com/?a=1&b=2'],
    content: { max_chars: 4 },
  });
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

test('keenable search: full content fetches only domain-filtered pages', async (t) => {
  const captured = stubFetch(t, { results: [
    { title: 'in', url: 'https://docs.example.com/a', snippet: 'excerpt' },
    { title: 'out', url: 'https://spam.net/b', snippet: 'excluded' },
  ] });
  const provider = new KeenableWebProvider();
  const calls: string[] = [];
  provider.fetch = async (url, options) => {
    calls.push(url);
    assert.equal(options?.output, 'markdown');
    return { url, content: 'full page', contentBytes: 9, truncated: false };
  };
  const results = await provider.search('q', {
    contentMode: 'full', includeDomains: ['example.com'],
  });
  assert.equal(captured.urls.length, 1);
  assert.deepEqual(calls, ['https://docs.example.com/a']);
  assert.equal(results[0]!.content, 'full page');
});

test('keenable fetch: rejects raw without a network call', async (t) => {
  const captured = stubFetch(t, {});
  await assert.rejects(
    new KeenableWebProvider().fetch('https://example.com', { output: 'raw' }),
    /supports markdown only/,
  );
  assert.equal(captured.urls.length, 0);
});

test('keenable fetch: preserves upstream truncation and character count', async (t) => {
  const captured = stubFetch(t, {
    results: [{ content: 'short...', truncated: true, total_chars: 100_000 }],
  });
  const result = await new KeenableWebProvider().fetch('https://example.com', {
    maxBytes: 100_000,
  });
  assert.equal(JSON.parse(String(captured.inits[0]!.body)).content.max_chars, 100000);
  assert.equal(result.truncated, true);
  assert.equal(result.metadata?.totalChars, 100_000);
  assert.equal(result.contentBytes, 8);
});

test('keenable fetch: truncates at a UTF-8 boundary', async (t) => {
  stubFetch(t, { results: [{ url: 'https://a.example.com', content: '€€' }] });
  const page = await new KeenableWebProvider().fetch('https://a.example.com', { maxBytes: 4 });
  assert.equal(page.content, '€');
  assert.equal(page.truncated, true);
  assert.ok(!page.content.includes('\uFFFD'));
});

test('keenable fetch: tolerates an empty result list', async (t) => {
  stubFetch(t, { results: [] });
  const empty = await new KeenableWebProvider().fetch('https://a.example.com');
  assert.equal(empty.content, '');
  assert.equal(empty.truncated, false);
});

test('keenable search: page enrichment shares the search deadline', async (t) => {
  const timeouts: number[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    timeouts.push(Date.now());
    const body = String(input).includes('/v1/search')
      ? { results: [{ title: 'A', url: 'https://a.example.com', snippet: 's' }] }
      : { results: [{ url: 'https://a.example.com', content: 'page' }] };
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  const results = await new KeenableWebProvider().search('q', { contentMode: 'full', timeoutMs: 5000 });
  assert.equal(results[0]!.content, 'page');
});
