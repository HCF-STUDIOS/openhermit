import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  filterResultsByDomains,
  hostMatchesDomain,
  normalizeDomain,
  urlMatchesDomainFilters,
} from '../src/web/domains.js';
import { ExaWebProvider } from '../src/web/providers/exa.js';
import { TavilyWebProvider } from '../src/web/providers/tavily.js';

// ─── normalizeDomain / hostMatchesDomain ──────────────────────────────────

test('normalizeDomain: strips wildcards, dots, and casing', () => {
  assert.equal(normalizeDomain('Example.COM'), 'example.com');
  assert.equal(normalizeDomain('*.example.com'), 'example.com');
  assert.equal(normalizeDomain('.example.com'), 'example.com');
  assert.equal(normalizeDomain('example.com.'), 'example.com');
  assert.equal(normalizeDomain('  example.com '), 'example.com');
});

test('hostMatchesDomain: exact and subdomain matches only', () => {
  assert.equal(hostMatchesDomain('example.com', 'example.com'), true);
  assert.equal(hostMatchesDomain('docs.example.com', 'example.com'), true);
  assert.equal(hostMatchesDomain('a.b.example.com', 'example.com'), true);
  assert.equal(hostMatchesDomain('EXAMPLE.COM', 'example.com'), true);
  // suffix trap: notexample.com is NOT a subdomain of example.com
  assert.equal(hostMatchesDomain('notexample.com', 'example.com'), false);
  assert.equal(hostMatchesDomain('example.com.evil.net', 'example.com'), false);
  assert.equal(hostMatchesDomain('example.com', ''), false);
});

// ─── urlMatchesDomainFilters ──────────────────────────────────────────────

test('urlMatchesDomainFilters: include restricts, exclude wins, garbage fails closed', () => {
  assert.equal(
    urlMatchesDomainFilters('https://docs.example.com/x', ['example.com']),
    true,
  );
  assert.equal(
    urlMatchesDomainFilters('https://other.net/x', ['example.com']),
    false,
  );
  // exclusion beats inclusion
  assert.equal(
    urlMatchesDomainFilters('https://bad.example.com/x', ['example.com'], ['bad.example.com']),
    false,
  );
  // no filters → allowed
  assert.equal(urlMatchesDomainFilters('https://anything.net/'), true);
  // unparseable URL → fail closed
  assert.equal(urlMatchesDomainFilters('::not-a-url::', ['example.com']), false);
});

test('filterResultsByDomains: passthrough without filters, strict with', () => {
  const results = [
    { url: 'https://a.example.com/1' },
    { url: 'https://spam.net/2' },
    { url: 'https://example.com/3' },
  ];
  assert.deepEqual(filterResultsByDomains(results), results);
  assert.deepEqual(
    filterResultsByDomains(results, ['example.com']).map((r) => r.url),
    ['https://a.example.com/1', 'https://example.com/3'],
  );
  assert.deepEqual(
    filterResultsByDomains(results, undefined, ['spam.net']).map((r) => r.url),
    ['https://a.example.com/1', 'https://example.com/3'],
  );
});

// ─── Provider post-filtering (API results that ignore the filters) ────────

const stubFetchJson = (
  t: import('node:test').TestContext,
  payload: unknown,
): { bodies: unknown[] } => {
  const captured: { bodies: unknown[] } = { bodies: [] };
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    if (init?.body) captured.bodies.push(JSON.parse(String(init.body)));
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

test('tavily search: forwards domain filters AND strictly post-filters', async (t) => {
  const captured = stubFetchJson(t, {
    results: [
      { title: 'ok', url: 'https://docs.example.com/a', content: 'x' },
      // API "leaked" a result outside the include list
      { title: 'leak', url: 'https://leaky.net/b', content: 'y' },
    ],
  });
  const provider = new TavilyWebProvider('key');
  const results = await provider.search('q', { includeDomains: ['example.com'] });
  assert.deepEqual(results.map((r) => r.url), ['https://docs.example.com/a']);
  const body = captured.bodies[0] as Record<string, unknown>;
  assert.deepEqual(body.include_domains, ['example.com']);
});

test('exa search: forwards domain filters AND strictly post-filters', async (t) => {
  const captured = stubFetchJson(t, {
    results: [
      { title: 'ok', url: 'https://docs.example.com/a' },
      { title: 'leak', url: 'https://leaky.net/b' },
    ],
  });
  const provider = new ExaWebProvider('key');
  const results = await provider.search('q', {
    includeDomains: ['example.com'],
    excludeDomains: ['spam.net'],
  });
  assert.deepEqual(results.map((r) => r.url), ['https://docs.example.com/a']);
  const body = captured.bodies[0] as Record<string, unknown>;
  assert.deepEqual(body.includeDomains, ['example.com']);
  assert.deepEqual(body.excludeDomains, ['spam.net']);
});

test('exa search: exclude filter drops matching results', async (t) => {
  stubFetchJson(t, {
    results: [
      { title: 'keep', url: 'https://good.org/a' },
      { title: 'drop', url: 'https://sub.spam.net/b' },
    ],
  });
  const provider = new ExaWebProvider('key');
  const results = await provider.search('q', { excludeDomains: ['spam.net'] });
  assert.deepEqual(results.map((r) => r.url), ['https://good.org/a']);
});
