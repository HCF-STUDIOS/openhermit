/**
 * Ogg/Opus playtime extraction for outbound WeChat voice notes.
 *
 * WeChat (via iLink) renders bot-sent voice as Ogg/Opus, NOT SILK — Tencent's
 * own `openclaw-weixin` (>=2.4.x `src/media/voice-outbound.ts`) transcodes
 * outbound voice to Ogg/Opus @ 48 kHz (`encode_type` 8) and derives `playtime`
 * from the Opus granule position. SILK is the QQ format and is silently dropped
 * by iLink on the bot→user direction. This parser is a dependency-free port of
 * Tencent's granule-based duration calc so we can set a correct `playtime`.
 */

const OGG_CAPTURE = Buffer.from('OggS');
const OPUS_HEAD_MAGIC = Buffer.from('OpusHead');
const GP_UNKNOWN = 0xffffffffffffffffn;

/** Walk one Ogg page; return the byte offset after it, or null if malformed. */
function skipOggPage(buf: Buffer, start: number): number | null {
  if (start + 27 > buf.length) return null;
  if (!buf.subarray(start, start + 4).equals(OGG_CAPTURE)) return null;
  const nsegs = buf[start + 26]!;
  if (start + 27 + nsegs > buf.length) return null;
  let bodySize = 0;
  for (let i = 0; i < nsegs; i++) bodySize += buf[start + 27 + i]!;
  const end = start + 27 + nsegs + bodySize;
  return end > buf.length ? null : end;
}

/** Serial of the first Ogg logical stream whose first packet is OpusHead. */
function findOpusStreamSerial(buf: Buffer): number | null {
  let off = 0;
  while (off < buf.length) {
    const idx = buf.indexOf(OGG_CAPTURE, off);
    if (idx < 0) return null;
    const end = skipOggPage(buf, idx);
    if (end === null) {
      off = idx + 1;
      continue;
    }
    const nsegs = buf[idx + 26]!;
    const bodyStart = idx + 27 + nsegs;
    const firstSegLen = nsegs > 0 ? buf[idx + 27]! : 0;
    if (firstSegLen >= OPUS_HEAD_MAGIC.length && bodyStart + firstSegLen <= buf.length) {
      const payload = buf.subarray(bodyStart, bodyStart + firstSegLen);
      if (payload.subarray(0, OPUS_HEAD_MAGIC.length).equals(OPUS_HEAD_MAGIC)) {
        return buf.readUInt32LE(idx + 14);
      }
    }
    off = end;
  }
  return null;
}

function maxGranuleForSerial(buf: Buffer, targetSerial: number): bigint {
  let off = 0;
  let maxGp = 0n;
  while (off < buf.length) {
    const idx = buf.indexOf(OGG_CAPTURE, off);
    if (idx < 0) break;
    const end = skipOggPage(buf, idx);
    if (end === null) {
      off = idx + 1;
      continue;
    }
    if (buf.readUInt32LE(idx + 14) === targetSerial) {
      const gp = buf.readBigUInt64LE(idx + 6);
      if (gp !== GP_UNKNOWN && gp > maxGp) maxGp = gp;
    }
    off = end;
  }
  return maxGp;
}

/**
 * Duration (ms) of an Ogg/Opus buffer. Opus granule positions count 48 kHz
 * PCM samples (RFC 7845), so ms = granule * 1000 / 48000. Returns null when the
 * buffer is not a recognizable Ogg/Opus stream.
 */
export function oggOpusPlaytimeMs(buf: Buffer): number | null {
  const serial = findOpusStreamSerial(buf);
  if (serial === null) return null;
  const maxGp = maxGranuleForSerial(buf, serial);
  if (maxGp <= 0n) return null;
  const ms = Number((maxGp * 1000n) / 48000n);
  return ms > 0 ? ms : null;
}
