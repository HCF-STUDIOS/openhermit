/**
 * WeChat CDN media download + AES-128-ECB decryption.
 *
 * Ported from Tencent's MIT-licensed `openclaw-weixin`
 * (`src/cdn/aes-ecb.ts`, `src/cdn/pic-decrypt.ts`, `src/cdn/cdn-url.ts`):
 *
 *   Copyright (C) 2026 Tencent. Licensed under the MIT License.
 *
 * Inbound media items reference encrypted bytes on the WeChat C2C CDN. Each
 * `CDNMedia` carries either a complete `full_url` (preferred) or an
 * `encrypt_query_param` the client assembles against a CDN base URL, plus an
 * AES key. Bytes are AES-128-ECB encrypted and must be decrypted after fetch.
 */
import { createCipheriv, createDecipheriv } from 'node:crypto';

/** Default WeChat C2C CDN base, overridable via env. Only used when a media
 * item lacks a server-provided `full_url`. */
export const CDN_BASE_URL =
  process.env.OPENHERMIT_WECHAT_CDN_BASE_URL ?? 'https://novac2c.cdn.weixin.qq.com/c2c';

/** Decrypt AES-128-ECB (PKCS7 padding). */
export function decryptAesEcb(ciphertext: Buffer, key: Buffer): Buffer {
  const decipher = createDecipheriv('aes-128-ecb', key, null);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/** Encrypt AES-128-ECB (PKCS7 padding) — for outbound CDN uploads. */
export function encryptAesEcb(plaintext: Buffer, key: Buffer): Buffer {
  const cipher = createCipheriv('aes-128-ecb', key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

/** Ciphertext size of `n` plaintext bytes under AES-128-ECB + PKCS7 padding. */
export function aesEcbPaddedSize(n: number): number {
  return Math.ceil((n + 1) / 16) * 16;
}

/**
 * Parse a `CDNMedia.aes_key` JSON field into a raw 16-byte AES key. Two
 * encodings occur in the wild:
 *   - base64(raw 16 bytes)           → images (from the `media` field)
 *   - base64(32-char hex string)     → file / voice / video
 */
export function parseAesKey(aesKeyBase64: string): Buffer {
  const decoded = Buffer.from(aesKeyBase64, 'base64');
  if (decoded.length === 16) return decoded;
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString('ascii'))) {
    return Buffer.from(decoded.toString('ascii'), 'hex');
  }
  throw new Error(
    `aes_key must decode to 16 raw bytes or a 32-char hex string, got ${decoded.length} bytes`,
  );
}

/** Build a CDN download URL from an encrypt_query_param when no full_url is given. */
export function buildCdnDownloadUrl(encryptedQueryParam: string, cdnBaseUrl: string): string {
  return `${cdnBaseUrl}/download?encrypted_query_param=${encodeURIComponent(encryptedQueryParam)}`;
}

/** Build a CDN upload URL from `upload_param` + `filekey` when the server
 * returns no `upload_full_url` (mirrors the reference's fallback assembly). */
export function buildCdnUploadUrl(
  uploadParam: string,
  filekey: string,
  cdnBaseUrl: string,
): string {
  return (
    `${cdnBaseUrl}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}` +
    `&filekey=${encodeURIComponent(filekey)}`
  );
}

/** Resolve the download URL for a media item, preferring the server's full_url. */
export function resolveCdnUrl(
  encryptQueryParam: string | undefined,
  fullUrl: string | undefined,
  cdnBaseUrl: string,
): string {
  if (fullUrl) return fullUrl;
  if (encryptQueryParam) return buildCdnDownloadUrl(encryptQueryParam, cdnBaseUrl);
  throw new Error('media item has neither full_url nor encrypt_query_param');
}

/**
 * Download and AES-128-ECB decrypt a CDN media file. `maxBytes` caps the
 * download (rejected up front via content-length, then enforced on the body).
 */
export async function downloadAndDecrypt(params: {
  url: string;
  aesKeyBase64: string;
  maxBytes: number;
  timeoutMs?: number;
}): Promise<Buffer> {
  const { url, aesKeyBase64, maxBytes, timeoutMs = 15_000 } = params;
  const key = parseAesKey(aesKeyBase64);

  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`CDN download failed (${res.status})`);

  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`CDN media exceeds the ${maxBytes}-byte limit (content-length ${declared})`);
  }

  const encrypted = Buffer.from(await res.arrayBuffer());
  if (encrypted.byteLength > maxBytes) {
    throw new Error(`CDN media exceeds the ${maxBytes}-byte limit (${encrypted.byteLength} bytes)`);
  }
  return decryptAesEcb(encrypted, key);
}
