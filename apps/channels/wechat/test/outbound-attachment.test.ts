import assert from 'node:assert/strict';
import { test } from 'node:test';

import { WechatBridge } from '../src/bridge.js';

interface SentMsg {
  item_list?: Array<Record<string, unknown>>;
}

/**
 * Drive `deliverAttachment` with a stubbed agent client + fetch, and return the
 * `sendmessage` body that the bridge produced for the given attachment.
 */
async function deliver(opts: {
  bytes: Uint8Array;
  mimeType: string;
  kind?: string;
  attKind?: string;
  name?: string;
  caption?: string;
}): Promise<SentMsg[]> {
  const bridge = new WechatBridge(
    { baseUrl: 'https://bot.example/', botToken: 'tok' },
    { baseUrl: 'https://agent.example/', token: 'ctok' },
    () => {},
  );
  // Stub the agent-local client's attachment download.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (bridge as any).client.downloadAttachmentBytes = async () => ({
    bytes: opts.bytes,
    mimeType: opts.mimeType,
    filename: opts.name,
    kind: opts.kind,
  });

  const sent: SentMsg[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.includes('getuploadurl')) {
      return new Response(JSON.stringify({ ret: 0, upload_param: 'UP' }), { status: 200 });
    }
    if (u.includes('/upload')) {
      return new Response(null, { status: 200, headers: { 'x-encrypted-param': 'DL' } });
    }
    if (u.includes('sendmessage')) {
      const body = JSON.parse(String(init?.body)) as { msg?: SentMsg };
      if (body.msg) sent.push(body.msg);
      return new Response(JSON.stringify({ ret: 0 }), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  }) as typeof fetch;

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (bridge as any).deliverAttachment(
      'wxid_peer',
      {
        sessionId: 's1',
        attachmentId: 'a1',
        ...(opts.attKind ? { kind: opts.attKind } : {}),
        ...(opts.name ? { name: opts.name } : {}),
        ...(opts.caption ? { caption: opts.caption } : {}),
      },
      undefined,
    );
  } finally {
    globalThis.fetch = original;
  }
  return sent;
}

/** Find the single item of a given kind across all sent messages. */
function findItem(msgs: SentMsg[], key: string): Record<string, unknown> | undefined {
  for (const m of msgs) {
    const it = m.item_list?.find((i) => (i as Record<string, unknown>)[key]);
    if (it) return it as Record<string, unknown>;
  }
  return undefined;
}

test('every sent message carries exactly one item (iLink requirement)', async () => {
  const msgs = await deliver({
    bytes: new Uint8Array(10),
    mimeType: 'application/pdf',
    kind: 'document',
    name: 'a.pdf',
    caption: 'cap',
  });
  for (const m of msgs) assert.equal(m.item_list?.length, 1);
});

test('a document attachment is sent as a FILE item with name + plaintext len', async () => {
  const msgs = await deliver({
    bytes: new Uint8Array(50),
    mimeType: 'application/pdf',
    kind: 'document',
    name: 'report.pdf',
  });
  const item = findItem(msgs, 'file_item') as
    | { type: number; file_item: { media: Record<string, unknown>; file_name: string; len: string } }
    | undefined;
  assert.ok(item, 'should have a file_item');
  assert.equal(item!.type, 4); // MessageItemType.FILE
  assert.equal(item!.file_item.file_name, 'report.pdf');
  assert.equal(item!.file_item.len, '50'); // plaintext bytes
  assert.equal(item!.file_item.media.encrypt_query_param, 'DL');
  assert.equal(item!.file_item.media.encrypt_type, 1);
});

test('an image attachment is sent as an IMAGE item with ciphertext mid_size', async () => {
  const msgs = await deliver({ bytes: new Uint8Array(50), mimeType: 'image/jpeg', kind: 'image' });
  const item = findItem(msgs, 'image_item') as
    | { type: number; image_item: { mid_size: number } }
    | undefined;
  assert.ok(item, 'should have an image_item');
  assert.equal(item!.type, 2); // MessageItemType.IMAGE
  assert.equal(item!.image_item.mid_size, 64); // padded ciphertext size of 50 bytes
});

test('a caption is sent as its own TEXT message before the media message', async () => {
  const msgs = await deliver({
    bytes: new Uint8Array(10),
    mimeType: 'application/pdf',
    kind: 'document',
    name: 'a.pdf',
    caption: 'here you go',
  });
  assert.equal(msgs.length, 2);
  const textItem = msgs[0]!.item_list![0] as { type: number; text_item?: { text: string } };
  assert.equal(textItem.type, 1); // TEXT
  assert.equal(textItem.text_item?.text, 'here you go');
  assert.ok(findItem(msgs, 'file_item'), 'media follows the caption');
});

test('the attachment kind hint overrides the downloaded kind', async () => {
  // download reports no kind, but the SSE event hinted image
  const msgs = await deliver({ bytes: new Uint8Array(10), mimeType: 'image/png', attKind: 'image' });
  assert.ok(findItem(msgs, 'image_item'));
});
