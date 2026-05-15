import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChannelSetupContext } from '@openhermit/protocol';

import { createSignalSetup } from '../src/setup.js';

const ctx: ChannelSetupContext = { agentId: 'agent-1', logger: () => {} };

test('begin() returns awaiting_user_input asking for http_url and phone_number', async () => {
  const setup = createSignalSetup();
  const { sessionId, state } = await setup.begin({}, ctx);
  assert.ok(sessionId);
  assert.equal(state.kind, 'awaiting_user_input');
  if (state.kind !== 'awaiting_user_input') return;
  const names = state.fields.map((f) => f.key).sort();
  assert.deepEqual(names, ['http_url', 'phone_number']);
});

test('submit() with invalid phone number returns error state', async () => {
  const setup = createSignalSetup();
  const { sessionId } = await setup.begin({}, ctx);
  const state = await setup.submit!(
    sessionId,
    { http_url: 'http://signal:8080', phone_number: 'not-a-number' },
    ctx,
  );
  assert.equal(state.kind, 'error');
});

test('submit() with valid input transitions to awaiting_external with a QR data URL', async () => {
  const fakePng = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  const fetchSpy: typeof fetch = async (input) => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    if (url.includes('/v1/qrcodelink/')) {
      return new Response(fakePng, { status: 200, headers: { 'content-type': 'image/png' } });
    }
    return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const setup = createSignalSetup({ fetch: fetchSpy });
  const { sessionId } = await setup.begin({}, ctx);
  const state = await setup.submit!(
    sessionId,
    { http_url: 'http://signal:8080', phone_number: '+15551234567' },
    ctx,
  );
  assert.equal(state.kind, 'awaiting_external');
  if (state.kind !== 'awaiting_external') return;
  assert.match(state.qrText ?? '', /^data:image\/png;base64,/);
  assert.equal(state.pollIntervalMs, 1500);
});

test('poll() returns done when /v1/accounts contains the linked number', async () => {
  const fakePng = new Uint8Array([0x89]);
  let pollHits = 0;
  const fetchSpy: typeof fetch = async (input) => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    if (url.includes('/v1/qrcodelink/')) {
      return new Response(fakePng, { status: 200 });
    }
    pollHits += 1;
    const body = pollHits >= 2 ? ['+15551234567'] : [];
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const setup = createSignalSetup({ fetch: fetchSpy });
  const { sessionId } = await setup.begin({}, ctx);
  await setup.submit!(
    sessionId,
    { http_url: 'http://signal:8080', phone_number: '+15551234567' },
    ctx,
  );
  let state = await setup.poll(sessionId, ctx);
  assert.equal(state.kind, 'awaiting_external');
  state = await setup.poll(sessionId, ctx);
  assert.equal(state.kind, 'done');
  if (state.kind !== 'done') return;
  assert.deepEqual(state.config, {
    http_url: 'http://signal:8080',
    account: '+15551234567',
  });
});

test('cancel() drops the session so subsequent polls error', async () => {
  const setup = createSignalSetup();
  const { sessionId } = await setup.begin({}, ctx);
  await setup.cancel!(sessionId, ctx);
  const state = await setup.poll(sessionId, ctx);
  assert.equal(state.kind, 'error');
});
