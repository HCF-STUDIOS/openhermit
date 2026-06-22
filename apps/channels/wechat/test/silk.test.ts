import assert from 'node:assert/strict';
import { test } from 'node:test';

import { pcmToWav, silkToWav, toSilk, SILK_SAMPLE_RATE } from '../src/ilink/silk.js';

/** Build ~0.4s of mono s16le PCM at the given rate (a quiet sine tone). */
function makeTonePcm(sampleRate = SILK_SAMPLE_RATE, ms = 400): Uint8Array {
  const n = Math.round((sampleRate * ms) / 1000);
  const buf = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const sample = Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 8000);
    buf.writeInt16LE(sample, i * 2);
  }
  return buf;
}

test('pcmToWav writes a canonical 44-byte mono/16-bit RIFF header', () => {
  const pcm = makeTonePcm(SILK_SAMPLE_RATE, 100);
  const wav = pcmToWav(pcm, SILK_SAMPLE_RATE);

  assert.equal(wav.subarray(0, 4).toString('ascii'), 'RIFF');
  assert.equal(wav.subarray(8, 12).toString('ascii'), 'WAVE');
  assert.equal(wav.subarray(12, 16).toString('ascii'), 'fmt ');
  assert.equal(wav.subarray(36, 40).toString('ascii'), 'data');
  assert.equal(wav.readUInt16LE(20), 1); // PCM
  assert.equal(wav.readUInt16LE(22), 1); // mono
  assert.equal(wav.readUInt32LE(24), SILK_SAMPLE_RATE);
  assert.equal(wav.readUInt16LE(34), 16); // bits per sample
  assert.equal(wav.readUInt32LE(40), pcm.byteLength); // data size
  assert.equal(wav.byteLength, 44 + pcm.byteLength);
});

test('toSilk → silkToWav round-trips PCM through the real codec', async () => {
  const pcm = makeTonePcm();
  const encoded = await toSilk(pcm, SILK_SAMPLE_RATE);
  assert.ok(encoded, 'encode should succeed');
  assert.ok(encoded!.silk.byteLength > 0);
  assert.ok(encoded!.durationMs > 0);

  const decoded = await silkToWav(encoded!.silk, SILK_SAMPLE_RATE);
  assert.ok(decoded, 'decode should succeed');
  assert.equal(decoded!.wav.subarray(0, 4).toString('ascii'), 'RIFF');
  assert.ok(decoded!.wav.byteLength > 44, 'decoded wav should carry audio data');
});

test('toSilk accepts a WAV container directly (sampleRate 0)', async () => {
  const wav = pcmToWav(makeTonePcm(), SILK_SAMPLE_RATE);
  const encoded = await toSilk(wav, 0);
  assert.ok(encoded, 'encode from WAV should succeed');
  assert.ok(encoded!.silk.byteLength > 0);
});

test('silkToWav returns null on garbage input instead of throwing', async () => {
  const out = await silkToWav(Buffer.from('not silk at all'));
  assert.equal(out, null);
});
