import assert from 'node:assert/strict';
import { createCipheriv, randomBytes } from 'node:crypto';
import { test } from 'node:test';

import {
  buildCdnDownloadUrl,
  decryptAesEcb,
  downloadAndDecrypt,
  parseAesKey,
  resolveCdnUrl,
} from '../src/ilink/media.js';

/** AES-128-ECB encrypt (PKCS7) — mirrors the WeChat CDN's encryption. */
function encryptAesEcb(plaintext: Buffer, key: Buffer): Buffer {
  const cipher = createCipheriv('aes-128-ecb', key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

async function withFetch(impl: typeof fetch, fn: () => Promise<void>): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    await fn();
  } finally {
    globalThis.fetch = original;
  }
}

test('parseAesKey accepts a base64 raw 16-byte key (image form)', () => {
  const key = randomBytes(16);
  assert.deepEqual(parseAesKey(key.toString('base64')), key);
});

test('parseAesKey accepts a base64-of-hex key (file/voice/video form)', () => {
  const key = randomBytes(16);
  const base64OfHex = Buffer.from(key.toString('hex'), 'ascii').toString('base64');
  assert.deepEqual(parseAesKey(base64OfHex), key);
});

test('parseAesKey rejects malformed keys', () => {
  assert.throws(() => parseAesKey(Buffer.from('too-short').toString('base64')), /16 raw bytes/);
});

test('decryptAesEcb round-trips with encryptAesEcb', () => {
  const key = randomBytes(16);
  const plaintext = Buffer.from('hello wechat image bytes ✅', 'utf-8');
  assert.deepEqual(decryptAesEcb(encryptAesEcb(plaintext, key), key), plaintext);
});

test('resolveCdnUrl prefers full_url, falls back to building from base', () => {
  assert.equal(resolveCdnUrl('q', 'https://cdn/full', 'https://base'), 'https://cdn/full');
  assert.equal(
    resolveCdnUrl('q==', undefined, 'https://base'),
    buildCdnDownloadUrl('q==', 'https://base'),
  );
  assert.throws(() => resolveCdnUrl(undefined, undefined, 'https://base'), /full_url|encrypt_query_param/);
});

test('downloadAndDecrypt fetches and decrypts CDN bytes', async () => {
  const key = randomBytes(16);
  const plaintext = randomBytes(64);
  const ciphertext = encryptAesEcb(plaintext, key);

  await withFetch(async () => new Response(ciphertext, { status: 200 }), async () => {
    const out = await downloadAndDecrypt({
      url: 'https://cdn/download?x=1',
      aesKeyBase64: key.toString('base64'),
      maxBytes: 1024,
    });
    assert.deepEqual(out, plaintext);
  });
});

test('downloadAndDecrypt rejects an oversized content-length up front', async () => {
  await withFetch(
    async () => new Response(new Uint8Array(16), { status: 200, headers: { 'content-length': '999999' } }),
    async () => {
      await assert.rejects(
        () => downloadAndDecrypt({
          url: 'https://cdn/x',
          aesKeyBase64: randomBytes(16).toString('base64'),
          maxBytes: 100,
        }),
        /exceeds the 100-byte limit/,
      );
    },
  );
});
