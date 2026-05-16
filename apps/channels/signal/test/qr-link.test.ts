import assert from 'node:assert/strict';
import { test } from 'node:test';

import { toBuffer as qrToBuffer } from 'qrcode';

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

async function makeSignalQrPng(uri: string): Promise<Uint8Array> {
  // Margin + larger scale make the synthetic QR robust enough for jsqr.
  const buf = await qrToBuffer(uri, { type: 'png', margin: 2, scale: 4 });
  return new Uint8Array(buf);
}

test('begin() decodes the daemon-rendered PNG and exposes the sgnl:// URI', async () => {
  const uri = 'sgnl://linkdevice?uuid=abc&pub_key=def';
  const png = await makeSignalQrPng(uri);
  const { fetch: spy, calls } = makeFetchSpy([{ bytes: png }]);
  const session = await QrLinkSession.begin({
    httpUrl: 'http://signal:8080',
    account: '+15551234567',
    fetch: spy,
  });
  assert.equal(calls[0]!.url, 'http://signal:8080/v1/qrcodelink?device_name=openhermit');
  assert.equal(calls[0]!.method, 'GET');
  assert.equal(session.qrUri, uri);
  // Back-compat: data URL still exposed for legacy consumers.
  assert.match(session.qrPngDataUrl, /^data:image\/png;base64,iVBORw/);
  assert.equal(session.account, '+15551234567');
  assert.equal(session.httpUrl, 'http://signal:8080');
});

test('poll() returns awaiting until /v1/accounts contains the bot number', async () => {
  const png = await makeSignalQrPng('sgnl://linkdevice?uuid=x&pub_key=y');
  const { fetch: spy } = makeFetchSpy([
    { bytes: png },
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

test('begin() throws when the returned bytes are not a parseable PNG', async () => {
  const garbage = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05]);
  const { fetch: spy } = makeFetchSpy([{ bytes: garbage }]);
  await assert.rejects(
    () => QrLinkSession.begin({
      httpUrl: 'http://signal:8080',
      account: '+15551234567',
      fetch: spy,
    }),
    /could not parse|could not decode/i,
  );
});
