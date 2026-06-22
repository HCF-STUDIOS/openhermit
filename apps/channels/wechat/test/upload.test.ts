import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { test } from 'node:test';

import { aesEcbPaddedSize, decryptAesEcb, encryptAesEcb } from '../src/ilink/media.js';
import { uploadVoiceToCdn } from '../src/ilink/upload.js';

test('aesEcbPaddedSize rounds up to the next 16-byte block (incl. full-block pad)', () => {
  assert.equal(aesEcbPaddedSize(0), 16);
  assert.equal(aesEcbPaddedSize(1), 16);
  assert.equal(aesEcbPaddedSize(15), 16);
  assert.equal(aesEcbPaddedSize(16), 32); // PKCS7 adds a full block at an exact multiple
  assert.equal(aesEcbPaddedSize(17), 32);
});

test('encryptAesEcb round-trips with decryptAesEcb', () => {
  const key = randomBytes(16);
  const plaintext = randomBytes(50);
  assert.deepEqual(decryptAesEcb(encryptAesEcb(plaintext, key), key), plaintext);
});

test('uploadVoiceToCdn declares plaintext/ciphertext sizes, encrypts, and returns the download ref', async () => {
  const silk = randomBytes(40);
  let uploadReq: { body?: string } = {};
  let postedBytes: Uint8Array | undefined;

  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.includes('getuploadurl')) {
      uploadReq = { body: init?.body as string };
      return new Response(
        JSON.stringify({ ret: 0, upload_full_url: 'https://cdn.example/upload?x=1' }),
        { status: 200 },
      );
    }
    // CDN upload leg — capture ciphertext, return the download ref in the header.
    postedBytes = init?.body as Uint8Array;
    return new Response(null, { status: 200, headers: { 'x-encrypted-param': 'DL_PARAM_123' } });
  }) as typeof fetch;

  try {
    const out = await uploadVoiceToCdn({
      baseUrl: 'https://bot.example/',
      token: 'tok',
      bytes: silk,
      toUserId: 'wxid_peer',
    });

    assert.equal(out.downloadEncryptedQueryParam, 'DL_PARAM_123');
    assert.match(out.aeskeyHex, /^[0-9a-f]{32}$/);
    assert.equal(out.rawsize, 40);

    const req = JSON.parse(uploadReq.body ?? '{}') as Record<string, unknown>;
    assert.equal(req.media_type, 4); // UploadMediaType.VOICE
    assert.equal(req.to_user_id, 'wxid_peer');
    assert.equal(req.rawsize, 40);
    assert.equal(req.rawfilemd5, createHash('md5').update(silk).digest('hex'));
    assert.equal(req.filesize, aesEcbPaddedSize(40)); // 48
    assert.equal(req.no_need_thumb, true);
    assert.equal(req.aeskey, out.aeskeyHex);

    // Posted bytes are the ciphertext: padded length, and decrypt back to silk.
    assert.ok(postedBytes);
    assert.equal(postedBytes!.byteLength, aesEcbPaddedSize(40));
    const key = Buffer.from(out.aeskeyHex, 'hex');
    assert.deepEqual(decryptAesEcb(Buffer.from(postedBytes!), key), silk);
  } finally {
    globalThis.fetch = original;
  }
});

test('uploadVoiceToCdn throws when the CDN omits x-encrypted-param', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request) => {
    if (String(url).includes('getuploadurl')) {
      return new Response(JSON.stringify({ upload_full_url: 'https://cdn.example/u' }), { status: 200 });
    }
    return new Response(null, { status: 200 }); // no header
  }) as typeof fetch;

  try {
    await assert.rejects(
      () =>
        uploadVoiceToCdn({
          baseUrl: 'https://bot.example/',
          token: 'tok',
          bytes: randomBytes(8),
          toUserId: 'p',
        }),
      /x-encrypted-param/,
    );
  } finally {
    globalThis.fetch = original;
  }
});
