/**
 * SILK ↔ WAV/PCM transcoding for WeChat voice notes.
 *
 * WeChat voice messages are SILK-encoded — a codec no STT/TTS provider
 * accepts directly. Inbound clips must be decoded to PCM and wrapped as WAV
 * before transcription; outbound replies must be encoded back to SILK before
 * upload. Both use `silk-wasm` (Tencent's WASM SILK codec), imported lazily so
 * the WASM blob only loads when a voice message actually flows through.
 *
 * The inbound decode mirrors Tencent's MIT `openclaw-weixin`
 * (`src/media/silk-transcode.ts`); the outbound encode has no upstream
 * template and is OpenHermit's own.
 */

/** WeChat SILK voice notes are 24 kHz, 16-bit, mono. */
export const SILK_SAMPLE_RATE = 24_000;

/**
 * Wrap raw little-endian 16-bit PCM in a 44-byte canonical RIFF/WAVE header so
 * a generic STT provider can decode it. Mono, 16-bit, `sampleRate` Hz.
 */
export function pcmToWav(pcm: Uint8Array, sampleRate = SILK_SAMPLE_RATE): Buffer {
  const channels = 1;
  const bitsPerSample = 16;
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.byteLength, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM format
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.byteLength, 40);
  return Buffer.concat([header, Buffer.from(pcm)]);
}

/**
 * Decode a SILK voice clip to a WAV buffer. Returns `null` (rather than
 * throwing) when `silk-wasm` is unavailable or the bytes fail to decode, so
 * callers can fall back to the WeChat-supplied transcript or skip the clip.
 */
export async function silkToWav(
  silk: Buffer,
  sampleRate = SILK_SAMPLE_RATE,
): Promise<{ wav: Buffer; durationMs: number } | null> {
  try {
    const { decode } = await import('silk-wasm');
    const result = await decode(silk, sampleRate);
    return { wav: pcmToWav(result.data, sampleRate), durationMs: result.duration };
  } catch {
    return null;
  }
}

/**
 * Encode WAV or raw mono `pcm_s16le` bytes to SILK for an outbound voice note.
 * `silk-wasm` accepts WAV directly (pass `sampleRate = 0`) or raw PCM (pass its
 * real sample rate). Returns `null` on failure so callers fall back to text.
 */
export async function toSilk(
  input: Uint8Array,
  sampleRate = SILK_SAMPLE_RATE,
): Promise<{ silk: Buffer; durationMs: number } | null> {
  try {
    const { encode } = await import('silk-wasm');
    const result = await encode(input, sampleRate);
    return { silk: Buffer.from(result.data), durationMs: result.duration };
  } catch {
    return null;
  }
}
