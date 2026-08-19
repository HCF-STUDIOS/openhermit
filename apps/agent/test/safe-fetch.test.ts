import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SafeFetchError, safeFetch } from '../src/network/safe-fetch.js';
import type { HostResolver } from '../src/attachments/ssrf.js';

const reasonOf = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return 'no-error';
  } catch (err) {
    if (err instanceof SafeFetchError) return err.reason;
    throw err;
  }
};

const stubFetch = (
  t: import('node:test').TestContext,
  impl: (input: string, init: RequestInit) => Promise<Response>,
): string[] => {
  const urls: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init: unknown) => {
    const url = String(input);
    urls.push(url);
    return impl(url, init as RequestInit);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  return urls;
};

// ─── URL validation (before any request) ──────────────────────────────────

test('safeFetch: malformed URL', async () => {
  assert.equal(await reasonOf(safeFetch('not a url')), 'malformed_url');
});

test('safeFetch: protocol allowlist defaults to https-only', async () => {
  assert.equal(
    await reasonOf(safeFetch('http://example.com/')),
    'protocol_not_allowed',
  );
  assert.equal(
    await reasonOf(safeFetch('file:///etc/passwd')),
    'protocol_not_allowed',
  );
});

test('safeFetch: http allowed when the caller opts in', async (t) => {
  stubFetch(t, async () => new Response('ok', { status: 200 }));
  const res = await safeFetch('http://example.com/', {
    allowedProtocols: ['http:', 'https:'],
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.toString(), 'ok');
});

test('safeFetch: rejects embedded credentials', async () => {
  assert.equal(
    await reasonOf(safeFetch('https://user:pass@example.com/')),
    'credentials_in_url',
  );
});

test('safeFetch: blocks literal internal hosts pre-connect', async () => {
  for (const url of [
    'https://127.0.0.1/x',
    'https://localhost/x',
    'https://169.254.169.254/latest/meta-data/',
    'https://[::1]/x',
    'https://10.0.0.8/x',
  ]) {
    assert.equal(await reasonOf(safeFetch(url)), 'blocked_host', url);
  }
});

test('safeFetch: DNS-alias host (public name → private IP) refused at connect', async () => {
  const resolveHost: HostResolver = async () => ['127.0.0.1'];
  try {
    await safeFetch('https://innocent-cdn.test/asset.png', { resolveHost });
    assert.fail('expected rejection');
  } catch (err) {
    assert.ok(err instanceof SafeFetchError);
    assert.equal(err.reason, 'network');
    assert.match(err.message, /SSRF guard/i);
  }
});

// ─── Redirect handling ─────────────────────────────────────────────────────

test('safeFetch: redirect to an internal target is blocked per hop', async (t) => {
  stubFetch(t, async () =>
    new Response(null, {
      status: 302,
      headers: { location: 'https://169.254.169.254/latest/meta-data/' },
    }),
  );
  assert.equal(
    await reasonOf(safeFetch('https://example.com/start')),
    'blocked_host',
  );
});

test('safeFetch: redirect downgrading protocol is blocked when not allowed', async (t) => {
  stubFetch(t, async () =>
    new Response(null, {
      status: 302,
      headers: { location: 'http://example.com/other' },
    }),
  );
  assert.equal(
    await reasonOf(safeFetch('https://example.com/start')),
    'protocol_not_allowed',
  );
});

test('safeFetch: follows redirects and reports finalUrl + hop count', async (t) => {
  stubFetch(t, async (url) => {
    if (url === 'https://example.com/a') {
      return new Response(null, {
        status: 301,
        headers: { location: 'https://example.com/b' },
      });
    }
    return new Response('landed', { status: 200 });
  });
  const res = await safeFetch('https://example.com/a');
  assert.equal(res.status, 200);
  assert.equal(res.finalUrl, 'https://example.com/b');
  assert.equal(res.redirects, 1);
  assert.equal(res.body.toString(), 'landed');
});

test('safeFetch: caps redirect hops', async (t) => {
  let n = 0;
  stubFetch(t, async () => {
    n += 1;
    return new Response(null, {
      status: 302,
      headers: { location: `https://example.com/hop${n}` },
    });
  });
  assert.equal(
    await reasonOf(safeFetch('https://example.com/start', { maxRedirects: 3 })),
    'too_many_redirects',
  );
  assert.equal(n, 4); // initial request + 3 followed hops
});

// ─── Body size limits ──────────────────────────────────────────────────────

test('safeFetch: oversize content-length fails fast in error mode', async (t) => {
  stubFetch(t, async () =>
    new Response('xx', {
      status: 200,
      headers: { 'content-length': '99999999' },
    }),
  );
  assert.equal(
    await reasonOf(safeFetch('https://example.com/big', { maxBytes: 1024 })),
    'body_too_large',
  );
});

test('safeFetch: oversize streamed body (no content-length) fails in error mode', async (t) => {
  stubFetch(t, async () => new Response(Buffer.alloc(2048, 7), { status: 200 }));
  assert.equal(
    await reasonOf(safeFetch('https://example.com/big', { maxBytes: 1024 })),
    'body_too_large',
  );
});

test('safeFetch: truncate mode returns exactly maxBytes and flags it', async (t) => {
  stubFetch(t, async () => new Response(Buffer.alloc(2048, 7), { status: 200 }));
  const res = await safeFetch('https://example.com/big', {
    maxBytes: 1024,
    onOversize: 'truncate',
  });
  assert.equal(res.truncated, true);
  assert.equal(res.body.length, 1024);
});

test('safeFetch: body under the cap is untouched', async (t) => {
  stubFetch(t, async () => new Response('small', { status: 200 }));
  const res = await safeFetch('https://example.com/small', { maxBytes: 1024 });
  assert.equal(res.truncated, false);
  assert.equal(res.body.toString(), 'small');
});

// ─── Timeout and abort ─────────────────────────────────────────────────────

const hangUntilAborted = (init: RequestInit): Promise<Response> =>
  new Promise((_, reject) => {
    const signal = init.signal!;
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });

test('safeFetch: wall-clock timeout', async (t) => {
  stubFetch(t, async (_url, init) => hangUntilAborted(init));
  assert.equal(
    await reasonOf(safeFetch('https://example.com/slow', { timeoutMs: 50 })),
    'timeout',
  );
});

test('safeFetch: caller abort signal', async (t) => {
  stubFetch(t, async (_url, init) => hangUntilAborted(init));
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 20);
  assert.equal(
    await reasonOf(
      safeFetch('https://example.com/slow', {
        timeoutMs: 5_000,
        signal: controller.signal,
      }),
    ),
    'aborted',
  );
});

// ─── Header passthrough ────────────────────────────────────────────────────

test('safeFetch: sends caller headers and surfaces response headers', async (t) => {
  let sawUa: string | undefined;
  stubFetch(t, async (_url, init) => {
    sawUa = new Headers(init.headers).get('user-agent') ?? undefined;
    return new Response('ok', {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  });
  const res = await safeFetch('https://example.com/', {
    headers: { 'User-Agent': 'OpenHermit-Test/1.0' },
  });
  assert.equal(sawUa, 'OpenHermit-Test/1.0');
  assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8');
});

test('safeFetch: cross-origin redirect drops caller headers except content negotiation', async (t) => {
  const seen: Record<string, Headers> = {};
  stubFetch(t, async (url, init) => {
    seen[url] = new Headers(init.headers);
    if (url === 'https://a.example/start') {
      return new Response(null, {
        status: 302,
        headers: { location: 'https://b.example/next' },
      });
    }
    return new Response('ok', { status: 200 });
  });
  const res = await safeFetch('https://a.example/start', {
    headers: {
      'X-Api-Key': 'secret',
      'User-Agent': 'OpenHermit-Test/1.0',
      'Accept': 'text/html',
    },
  });
  assert.equal(res.status, 200);
  assert.equal(seen['https://a.example/start']!.get('x-api-key'), 'secret');
  const hop = seen['https://b.example/next']!;
  assert.equal(hop.get('x-api-key'), null, 'credential must not cross origins');
  assert.equal(hop.get('user-agent'), 'OpenHermit-Test/1.0');
  assert.equal(hop.get('accept'), 'text/html');
});

test('safeFetch: same-origin redirect keeps caller headers', async (t) => {
  const seen: Record<string, Headers> = {};
  stubFetch(t, async (url, init) => {
    seen[url] = new Headers(init.headers);
    if (url === 'https://a.example/one') {
      return new Response(null, { status: 302, headers: { location: '/two' } });
    }
    return new Response('ok', { status: 200 });
  });
  await safeFetch('https://a.example/one', { headers: { 'X-Api-Key': 'secret' } });
  assert.equal(seen['https://a.example/two']!.get('x-api-key'), 'secret');
});
