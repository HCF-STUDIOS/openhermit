/**
 * Outbound media upload to the WeChat C2C CDN.
 *
 * The reference `openclaw-weixin` implements this for image/video/file but NOT
 * for voice — this orchestration is OpenHermit's own, following the same shape:
 *   1. pick a random per-file AES key + filekey,
 *   2. declare plaintext size/md5 and ciphertext size to `getuploadurl`,
 *   3. AES-128-ECB encrypt the bytes and POST them to the returned URL,
 *   4. read the download reference from the `x-encrypted-param` response header.
 *
 * The resulting `UploadedMedia` is what an outbound `voice_item.media`
 * references so the recipient's client can fetch + decrypt the clip.
 */
import { createHash, randomBytes } from 'node:crypto';

import { getUploadUrl, uploadToCdn, type WeixinApiOptions } from './api.js';
import { CDN_BASE_URL, aesEcbPaddedSize, buildCdnUploadUrl, encryptAesEcb } from './media.js';
import { UploadMediaType } from './types.js';

export interface UploadedMedia {
  /** Goes into `media.encrypt_query_param` on the outbound item. */
  downloadEncryptedQueryParam: string;
  /** AES key as a hex string (matches how images encode `media.aes_key`). */
  aeskeyHex: string;
  /** Plaintext byte size. */
  rawsize: number;
}

/**
 * Encrypt + upload a media buffer to the CDN and return the download reference.
 * `mediaType` is one of {@link UploadMediaType}.
 */
export async function uploadMediaToCdn(
  opts: WeixinApiOptions & {
    bytes: Buffer;
    mediaType: number;
    toUserId: string;
  },
): Promise<UploadedMedia> {
  const aesKey = randomBytes(16);
  const aeskeyHex = aesKey.toString('hex');
  const filekey = randomBytes(16).toString('hex');
  const rawsize = opts.bytes.byteLength;
  const rawfilemd5 = createHash('md5').update(opts.bytes).digest('hex');
  const filesize = aesEcbPaddedSize(rawsize);

  const slot = await getUploadUrl({
    baseUrl: opts.baseUrl,
    token: opts.token,
    ...(opts.botAgent ? { botAgent: opts.botAgent } : {}),
    req: {
      filekey,
      media_type: opts.mediaType,
      to_user_id: opts.toUserId,
      rawsize,
      rawfilemd5,
      filesize,
      no_need_thumb: true,
      aeskey: aeskeyHex,
    },
  });

  // Prefer the server's full URL; otherwise assemble one from upload_param +
  // filekey against the CDN base (the reference's fallback). If neither is
  // present the request was likely rejected — surface ret/errcode/errmsg.
  const uploadUrl =
    slot.upload_full_url ||
    (slot.upload_param ? buildCdnUploadUrl(slot.upload_param, filekey, CDN_BASE_URL) : undefined);
  if (!uploadUrl) {
    throw new Error(
      `getUploadUrl returned no usable URL (ret=${slot.ret} errcode=${slot.errcode} ` +
        `errmsg=${slot.errmsg ?? ''} keys=${Object.keys(slot).join(',')})`,
    );
  }

  const ciphertext = encryptAesEcb(opts.bytes, aesKey);
  const { downloadEncryptedQueryParam } = await uploadToCdn({ uploadUrl, ciphertext });

  return { downloadEncryptedQueryParam, aeskeyHex, rawsize };
}

/** Convenience wrapper for uploading a SILK voice clip. */
export function uploadVoiceToCdn(
  opts: WeixinApiOptions & { bytes: Buffer; toUserId: string },
): Promise<UploadedMedia> {
  return uploadMediaToCdn({ ...opts, mediaType: UploadMediaType.VOICE });
}
