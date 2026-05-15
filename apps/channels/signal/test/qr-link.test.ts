import assert from 'node:assert/strict';
import { test } from 'node:test';

import { QrLinkSession } from '../src/qr-link.js';

interface RecordedCall { url: string; method: string; }

function makeFetchSpy(responses: Array<{ status?: number; body?: unknown; bytes?: Uint8Array }>): {
  fetch: typeof fetch;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  let i = 0;
  const spy: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    calls.push({ url, method: (init?.method ?? 'GET').toUpperCase() });
    const r = responses[Math.min(i, responses.length - 1)];
    i += 1;
    const status = r?.status ?? 200;
    if (status === 204 || status === 304) return new Response(null, { status });
    if (r?.bytes) {
      return new Response(r.bytes, { status, headers: { 'content-type': 'image/png' } });
    }
    return new Response(JSON.stringify(r?.body ?? {}), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetch: spy, calls };
}

test('begin() requests QR PNG and exposes it as a base64 data URL', async () => {
  const fakePng = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x01, 0x02, 0x03]);
  const { fetch: spy, calls } = makeFetchSpy([{ bytes: fakePng }]);
  const session = await QrLinkSession.begin({
    httpUrl: 'http://signal:8080',
    account: '+15551234567',
    fetch: spy,
  });
  assert.equal(calls[0]!.url, 'http://signal:8080/v1/qrcodelink/%2B15551234567');
  assert.equal(calls[0]!.method, 'GET');
  assert.match(session.qrPngDataUrl, /^data:image\/png;base64,iVBORw/);
  assert.equal(session.account, '+15551234567');
  assert.equal(session.httpUrl, 'http://signal:8080');
});

test('poll() returns awaiting until /v1/accounts contains the bot number', async () => {
  const fakePng = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  const { fetch: spy } = makeFetchSpy([
    { bytes: fakePng },
    { body: [] },                     // first poll: empty
    { body: ['+15559999999'] },       // second poll: other account, still no
    { body: ['+15551234567'] },       // third poll: linked
  ]);
  const session = await QrLinkSession.begin({
    httpUrl: 'http://signal:8080',
    account: '+15551234567',
    fetch: spy,
  });
  assert.equal(await session.poll(), 'awaiting');
  assert.equal(await session.poll(), 'awaiting');
  assert.equal(await session.poll(), 'linked');
});

test('begin() throws when daemon returns non-2xx for the QR request', async () => {
  const { fetch: spy } = makeFetchSpy([{ status: 500, body: { error: 'daemon down' } }]);
  await assert.rejects(
    () => QrLinkSession.begin({
      httpUrl: 'http://signal:8080',
      account: '+15551234567',
      fetch: spy,
    }),
    /500/,
  );
});
