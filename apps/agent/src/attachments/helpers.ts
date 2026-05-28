import { filetypemime } from 'magic-bytes.js';
import mime from 'mime-types';

export const DEFAULT_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;

/**
 * Strip path components, normalise unsafe chars, and bound the length so a
 * client-supplied `originalName` is safe to use as a filename on disk and in
 * the sandbox. Empty / all-dots names get a fallback. Extension is preserved
 * (lowercased) when present.
 */
export const sanitizeName = (raw: string): string => {
  const base = raw.split(/[\\/]/).pop() ?? raw;
  const trimmed = base.replace(/[\x00-\x1f\x7f]/g, '').trim();
  const cleaned = trimmed.replace(/[^A-Za-z0-9._-]+/g, '_');
  const noLeadingDots = cleaned.replace(/^\.+/, '');
  const final = noLeadingDots || 'upload';
  if (final.length > 200) {
    const ext = final.includes('.') ? '.' + final.split('.').pop() : '';
    return final.slice(0, 200 - ext.length) + ext;
  }
  return final;
};

/**
 * Inspect the leading bytes of an uploaded file to pin down its MIME type.
 * Resolution order:
 *   1. magic-bytes.js sniff on the first 4096 bytes (most authoritative).
 *   2. mime-types' filename lookup as a fallback for text-y files magic
 *      bytes can't sniff (e.g. `.txt`, `.csv`, `.md`).
 *   3. The client-supplied `Content-Type`, last resort.
 *   4. `application/octet-stream` if nothing else holds.
 *
 * If the sniff disagrees with the client claim and the client claim looks
 * like a sane MIME, we still trust the sniff — clients lie about MIME more
 * often than magic bytes do.
 */
export const resolveMimeType = (
  bytes: Buffer,
  filename: string,
  clientClaim: string | undefined,
): string => {
  const sniffed = filetypemime(bytes.subarray(0, 4096));
  if (sniffed && sniffed.length > 0 && sniffed[0]) {
    return sniffed[0];
  }
  const byExt = mime.lookup(filename);
  if (byExt) return byExt;
  if (clientClaim && /^[\w.+-]+\/[\w.+-]+$/.test(clientClaim)) {
    return clientClaim;
  }
  return 'application/octet-stream';
};

/**
 * Coarse rendering hint for outbound attachments. Channels use this to pick
 * the right delivery primitive (Telegram sendPhoto vs sendDocument, web UI
 * <img> vs <a>, etc.).
 */
export type AttachmentKind = 'image' | 'audio' | 'video' | 'document';

export const inferAttachmentKind = (mimeType: string): AttachmentKind => {
  const m = mimeType.toLowerCase();
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('audio/')) return 'audio';
  if (m.startsWith('video/')) return 'video';
  return 'document';
};
