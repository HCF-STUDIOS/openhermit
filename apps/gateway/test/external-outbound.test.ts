import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  HttpChannelOutbound,
  buildExternalOutboundHandle,
  parseExternalOutboundConfig,
} from '../src/external-outbound.js';

test('parseExternalOutboundConfig requires both outboundUrl and recipientMetadataKey', () => {
  assert.deepEqual(
    parseExternalOutboundConfig({ outboundUrl: 'https://x/deliver', recipientMetadataKey: 'amiko_peer' }),
    { outboundUrl: 'https://x/deliver', recipientMetadataKey: 'amiko_peer' },
  );
  assert.equal(parseExternalOutboundConfig({ outboundUrl: 'https://x/deliver' }), undefined);
  assert.equal(parseExternalOutboundConfig({ recipientMetadataKey: 'k' }), undefined);
  assert.equal(parseExternalOutboundConfig({}), undefined);
  assert.equal(parseExternalOutboundConfig(undefined), undefined);
});

test('buildExternalOutboundHandle returns a handle only when opted in', () => {
  const ok = buildExternalOutboundHandle({
    channelType: 'amiko',
    token: 'tok',
    config: { outboundUrl: 'https://x/deliver', recipientMetadataKey: 'amiko_peer' },
  });
  assert.ok(ok);
  assert.equal(ok!.name, 'amiko');
  assert.ok(ok!.outbound);

  assert.equal(buildExternalOutboundHandle({ channelType: 'amiko', token: 't', config: {} }), undefined);
});

test('HttpChannelOutbound.resolveRecipient reads the configured metadata key', () => {
  const ob = new HttpChannelOutbound('amiko', {
    outboundUrl: 'https://x/deliver',
    recipientMetadataKey: 'amiko_peer',
  }, 'tok');
  assert.equal(
    ob.resolveRecipient({ source: { platform: 'amiko' }, metadata: { amiko_peer: 'u_123' } }),
    'u_123',
  );
  assert.equal(ob.resolveRecipient({ source: { platform: 'amiko' }, metadata: {} }), undefined);
  assert.equal(ob.resolveRecipient({ source: { platform: 'amiko' } }), undefined);
});

test('HttpChannelOutbound.send POSTs {sessionId,to,text} with the channel token', async () => {
  let captured: { url?: string; auth?: string; body?: unknown } = {};
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    captured = {
      url: String(url),
      auth: (init?.headers as Record<string, string>)?.authorization,
      body: JSON.parse(String(init?.body)),
    };
    return new Response(JSON.stringify({ messageId: 'm1' }), { status: 200 });
  }) as typeof fetch;

  try {
    const ob = new HttpChannelOutbound('amiko', {
      outboundUrl: 'https://x/deliver',
      recipientMetadataKey: 'amiko_peer',
    }, 'sekret');
    const res = await ob.send({ sessionId: 's1', to: 'u_123', text: 'hi' });
    assert.deepEqual(res, { success: true, messageId: 'm1' });
    assert.equal(captured.url, 'https://x/deliver');
    assert.equal(captured.auth, 'Bearer sekret');
    assert.deepEqual(captured.body, { sessionId: 's1', to: 'u_123', text: 'hi' });
  } finally {
    globalThis.fetch = original;
  }
});

test('HttpChannelOutbound.send sanitizes MiniMax word-per-line text before delivery', async () => {
  let sentText: unknown;
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    sentText = (JSON.parse(String(init?.body)) as { text: string }).text;
    return new Response(JSON.stringify({ messageId: 'm1' }), { status: 200 });
  }) as typeof fetch;

  try {
    const ob = new HttpChannelOutbound('amiko', {
      outboundUrl: 'https://x/deliver',
      recipientMetadataKey: 'amiko_peer',
    }, 'tok');
    const corrupted = '现在\n\n是\n\n北京时间\n\n10:21\n\nCST\n\n，早安\n\n已经\n\n发出\n\n去了';
    await ob.send({ sessionId: 's1', to: 'u_123', text: corrupted });
    assert.ok(!String(sentText).includes('\n'), `expected reflowed text, got: ${JSON.stringify(sentText)}`);
    assert.ok(String(sentText).includes('北京时间'));
  } finally {
    globalThis.fetch = original;
  }
});

test('HttpChannelOutbound.send reports failure on a non-2xx delivery', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response('nope', { status: 502 })) as typeof fetch;
  try {
    const ob = new HttpChannelOutbound('amiko', {
      outboundUrl: 'https://x/deliver',
      recipientMetadataKey: 'amiko_peer',
    }, 'tok');
    const res = await ob.send({ sessionId: 's', to: 'u', text: 't' });
    assert.equal(res.success, false);
    assert.match(res.error ?? '', /502/);
  } finally {
    globalThis.fetch = original;
  }
});
