import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';

import { WechatBridge } from '../src/bridge.js';
import { encryptAesEcb } from '../src/ilink/media.js';
import { MessageItemType, type WeixinMessage } from '../src/ilink/types.js';

interface Upload {
  filename: string;
  size: number;
}

/**
 * Run resolveInbound over a single-media message, stubbing the CDN download
 * (returns AES-encrypted plaintext) and the agent attachment upload. Returns
 * the resolved attachment ids and what was uploaded.
 */
async function resolve(msg: WeixinMessage): Promise<{ ids: number; uploads: Upload[] }> {
  const bridge = new WechatBridge(
    { baseUrl: 'https://bot.example/', botToken: 'tok' },
    { baseUrl: 'https://agent.example/', token: 'ctok' },
    () => {},
  );
  const uploads: Upload[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (bridge as any).client.uploadAttachment = async (_sid: string, blob: Blob, filename: string) => {
    uploads.push({ filename, size: blob.size });
    return { id: `att_${uploads.length}` };
  };

  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response(GLOBAL_CIPHERTEXT, { status: 200 })) as typeof fetch;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await (bridge as any).resolveInbound('s1', msg);
    return { ids: res.attachments?.length ?? 0, uploads };
  } finally {
    globalThis.fetch = original;
  }
}

// Shared encrypted payload + key for the stubbed CDN download.
const KEY = randomBytes(16);
const PLAINTEXT = randomBytes(120);
const GLOBAL_CIPHERTEXT = encryptAesEcb(PLAINTEXT, KEY);
const AES_KEY_B64 = KEY.toString('base64');

test('an inbound file_item is downloaded, decrypted, and uploaded with its name', async () => {
  const msg: WeixinMessage = {
    item_list: [
      {
        type: MessageItemType.FILE,
        file_item: { media: { full_url: 'https://cdn/x', aes_key: AES_KEY_B64 }, file_name: 'report.pdf' },
      },
    ],
  };
  const { ids, uploads } = await resolve(msg);
  assert.equal(ids, 1);
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0]!.filename, 'report.pdf');
  assert.equal(uploads[0]!.size, PLAINTEXT.length); // decrypted plaintext
});

test('an inbound video_item is uploaded as video.mp4', async () => {
  const msg: WeixinMessage = {
    item_list: [
      { type: MessageItemType.VIDEO, video_item: { media: { full_url: 'https://cdn/v', aes_key: AES_KEY_B64 } } },
    ],
  };
  const { ids, uploads } = await resolve(msg);
  assert.equal(ids, 1);
  assert.equal(uploads[0]!.filename, 'video.mp4');
});

test('a file_item with no aes key is skipped (no upload)', async () => {
  const msg: WeixinMessage = {
    item_list: [{ type: MessageItemType.FILE, file_item: { media: { full_url: 'https://cdn/x' }, file_name: 'x' } }],
  };
  const { ids, uploads } = await resolve(msg);
  assert.equal(ids, 0);
  assert.equal(uploads.length, 0);
});
