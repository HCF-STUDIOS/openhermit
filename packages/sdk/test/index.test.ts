import assert from 'node:assert/strict';
import test from 'node:test';

import { AgentLocalClient } from '../src/index.js';

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
