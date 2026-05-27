import assert from 'node:assert/strict';
import test from 'node:test';

import { AgentLocalClient, GatewayClient } from '../src/index.js';

test('AgentLocalClient surfaces network failures with a helpful local-agent message', async () => {
  const client = new AgentLocalClient({
    baseUrl: 'http://127.0.0.1:61092',
    token: 'test-token',
    fetch: async () => {
      throw new TypeError('fetch failed');
    },
  });

  await assert.rejects(
    () => client.listSessions(),
    /Agent local API is unavailable at http:\/\/127\.0\.0\.1:61092\/sessions/,
  );
  await assert.rejects(
    () => client.listSessions(),
    /npm run dev:agent/,
  );
});

test('transcribeAudio posts base64-encoded bytes and the mime type', async () => {
  const calls: Array<{ url: string; body: unknown }> = [];
  const client = new AgentLocalClient({
    baseUrl: 'http://localhost:9999',
    token: 'tok',
    fetch: async (input: any, init: any) => {
      calls.push({ url: String(input), body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ text: 'hello world', provider: 'elevenlabs' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  const result = await client.transcribeAudio({
    bytes: new Uint8Array([1, 2, 3, 4]),
    mimeType: 'audio/ogg',
  });

  assert.equal(result.text, 'hello world');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, 'http://localhost:9999/voice/stt');
  const body = calls[0]!.body as { bytes: string; mimeType: string };
  assert.equal(body.mimeType, 'audio/ogg');
  // base64 of [1,2,3,4] is AQIDBA==
  assert.equal(body.bytes, 'AQIDBA==');
});

test('GatewayClient.issueUserToken forwards purpose + ttlSeconds to the gateway', async () => {
  const calls: Array<{ url: string; body: unknown; headers: Record<string, string> }> = [];
  const result = await GatewayClient.issueUserToken({
    baseUrl: 'https://gateway.example',
    adminToken: 'admin-secret',
    channel: 'my-platform',
    channelUserId: 'user-42',
    purpose: 'exchange',
    ttlSeconds: 90,
    fetch: async (input: any, init: any) => {
      calls.push({
        url: String(input),
        body: JSON.parse(init.body),
        headers: init.headers,
      });
      return new Response(JSON.stringify({
        token: 'exchange-jwt',
        expiresAt: 1234567890,
        userId: 'usr-abc',
        isNewDevice: false,
        purpose: 'exchange',
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, 'https://gateway.example/api/admin/auth/issue-token');
  assert.equal(calls[0]!.headers.authorization, 'Bearer admin-secret');
  assert.deepEqual(calls[0]!.body, {
    channel: 'my-platform',
    channelUserId: 'user-42',
    purpose: 'exchange',
    ttlSeconds: 90,
  });
  assert.equal(result.token, 'exchange-jwt');
  assert.equal(result.purpose, 'exchange');
});

test('GatewayClient.issueUserToken omits purpose/ttlSeconds when not provided', async () => {
  const calls: Array<{ body: unknown }> = [];
  await GatewayClient.issueUserToken({
    baseUrl: 'https://gateway.example',
    adminToken: 'admin-secret',
    channel: 'my-platform',
    channelUserId: 'user-42',
    fetch: async (_input: any, init: any) => {
      calls.push({ body: JSON.parse(init.body) });
      return new Response(JSON.stringify({
        token: 't', expiresAt: 0, userId: 'u', isNewDevice: true, purpose: 'session',
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  assert.deepEqual(calls[0]!.body, {
    channel: 'my-platform',
    channelUserId: 'user-42',
  });
});

test('GatewayClient.exchangeConnectToken posts the token anonymously and parses the response', async () => {
  const calls: Array<{ url: string; body: unknown; headers: Record<string, string> }> = [];
  const result = await GatewayClient.exchangeConnectToken({
    baseUrl: 'https://gateway.example/',
    token: 'short-lived-exchange-jwt',
    fetch: async (input: any, init: any) => {
      calls.push({
        url: String(input),
        body: JSON.parse(init.body),
        headers: init.headers,
      });
      return new Response(JSON.stringify({
        token: 'session-jwt',
        expiresAt: 999,
        userId: 'usr-7',
        displayName: 'Ada',
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, 'https://gateway.example/api/auth/exchange');
  // Anonymous — no Authorization header should be sent.
  assert.equal(calls[0]!.headers.authorization, undefined);
  assert.deepEqual(calls[0]!.body, { token: 'short-lived-exchange-jwt' });
  assert.equal(result.token, 'session-jwt');
  assert.equal(result.userId, 'usr-7');
  assert.equal(result.displayName, 'Ada');
});

test('GatewayClient.exchangeConnectToken throws with the gateway error body on 401', async () => {
  await assert.rejects(
    () => GatewayClient.exchangeConnectToken({
      baseUrl: 'https://gateway.example',
      token: 'replayed-token',
      fetch: async () =>
        new Response('Exchange token has already been used.', { status: 401 }),
    }),
    /exchangeConnectToken failed \(401\): Exchange token has already been used\./,
  );
});

test('synthesizeAudio decodes base64 response back into Uint8Array', async () => {
  const client = new AgentLocalClient({
    baseUrl: 'http://localhost:9999',
    token: 'tok',
    fetch: async () => {
      return new Response(
        JSON.stringify({
          // base64 of [9,8,7] is CQgH
          bytes: 'CQgH',
          mimeType: 'audio/ogg',
          provider: 'elevenlabs',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    },
  });

  const result = await client.synthesizeAudio({
    text: 'hi',
    outputMimeType: 'audio/ogg',
  });

  assert.deepEqual(Array.from(result.bytes), [9, 8, 7]);
  assert.equal(result.mimeType, 'audio/ogg');
});
