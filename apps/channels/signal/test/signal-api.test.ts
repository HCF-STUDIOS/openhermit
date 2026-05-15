import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SignalApi } from '../src/signal-api.js';

interface RecordedCall {
  url: string;
  method: string;
  body?: unknown;
}

function makeFetchSpy(response: { status?: number; body?: unknown } = {}): {
  fetch: typeof fetch;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const spy: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    const call: RecordedCall = { url, method: (init?.method ?? 'GET').toUpperCase() };
    if (init?.body !== undefined) call.body = JSON.parse(String(init.body));
    calls.push(call);
    const status = response.status ?? 201;
    // Status 204 is a null-body status; Response constructor rejects a body for it.
    const isNullBody = status === 204 || status === 304;
    return new Response(isNullBody ? null : JSON.stringify(response.body ?? {}), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetch: spy, calls };
}

test('SignalApi.sendDirectMessage POSTs /v2/send with recipients = [E.164]', async () => {
  const { fetch: spy, calls } = makeFetchSpy({ body: { timestamp: 1234 } });
  const api = new SignalApi({ httpUrl: 'http://signal:8080', account: '+15551234567', fetch: spy });

  const result = await api.sendDirectMessage('+15559999999', 'hi');

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, 'http://signal:8080/v2/send');
  assert.equal(calls[0]!.method, 'POST');
  assert.deepEqual(calls[0]!.body, {
    number: '+15551234567',
    recipients: ['+15559999999'],
    message: 'hi',
    text_mode: 'styled',
  });
  assert.equal(result.timestamp, 1234);
});

test('SignalApi.sendGroupMessage POSTs with recipients = [groupId]', async () => {
  const { fetch: spy, calls } = makeFetchSpy({ body: { timestamp: 5678 } });
  const api = new SignalApi({ httpUrl: 'http://signal:8080', account: '+15551234567', fetch: spy });

  await api.sendGroupMessage('group.abc==', 'hi');

  assert.deepEqual(calls[0]!.body, {
    number: '+15551234567',
    recipients: ['group.abc=='],
    message: 'hi',
    text_mode: 'styled',
  });
});

test('SignalApi.sendTyping PUTs /v1/typing-indicator/{account}', async () => {
  const { fetch: spy, calls } = makeFetchSpy({ status: 204 });
  const api = new SignalApi({ httpUrl: 'http://signal:8080', account: '+15551234567', fetch: spy });

  await api.sendTyping('+15559999999');

  assert.equal(calls[0]!.method, 'PUT');
  assert.equal(calls[0]!.url, 'http://signal:8080/v1/typing-indicator/%2B15551234567');
  assert.deepEqual(calls[0]!.body, { recipient: '+15559999999' });
});

test('SignalApi.sendTyping does not throw on non-ok status (failures are non-fatal)', async () => {
  const { fetch: spy } = makeFetchSpy({ status: 500, body: { error: 'transient' } });
  const api = new SignalApi({ httpUrl: 'http://signal:8080', account: '+15551234567', fetch: spy });
  await api.sendTyping('+15559999999'); // must not throw
});

test('SignalApi.sendDirectMessage throws on non-2xx with the response body', async () => {
  const { fetch: spy } = makeFetchSpy({ status: 400, body: { error: 'invalid recipient' } });
  const api = new SignalApi({ httpUrl: 'http://signal:8080', account: '+15551234567', fetch: spy });

  await assert.rejects(() => api.sendDirectMessage('+1', 'x'), /invalid recipient/);
});

test('SignalApi.probeReceiveMode rejects when probe endpoint returns non-json-rpc mode', async () => {
  const { fetch: spy } = makeFetchSpy({ body: { mode: 'normal', version: '0.x' } });
  const api = new SignalApi({ httpUrl: 'http://signal:8080', account: '+15551234567', fetch: spy });

  await assert.rejects(
    () => api.probeReceiveMode(),
    /MODE=json-rpc/,
  );
});

test('SignalApi.probeReceiveMode resolves when /v1/about reports mode=json-rpc', async () => {
  const { fetch: spy } = makeFetchSpy({ body: { mode: 'json-rpc', version: '0.x' } });
  const api = new SignalApi({ httpUrl: 'http://signal:8080', account: '+15551234567', fetch: spy });

  await api.probeReceiveMode(); // does not throw
});
