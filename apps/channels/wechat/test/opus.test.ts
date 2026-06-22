import assert from 'node:assert/strict';
import { test } from 'node:test';

import { oggOpusPlaytimeMs } from '../src/ilink/opus.js';

/** Build a single Ogg page (27-byte header + segment table + body). CRC is left
 * zero — the parser doesn't verify it. */
function oggPage(granule: bigint, serial: number, seq: number, body: Buffer): Buffer {
  const header = Buffer.alloc(27 + 1);
  header.write('OggS', 0, 'ascii');
  header.writeUInt8(0, 4); // version
  header.writeUInt8(0, 5); // header type
  header.writeBigUInt64LE(granule, 6);
  header.writeUInt32LE(serial, 14);
  header.writeUInt32LE(seq, 18);
  header.writeUInt32LE(0, 22); // crc
  header.writeUInt8(1, 26); // 1 segment
  header.writeUInt8(body.length, 27); // segment length
  return Buffer.concat([header, body]);
}

test('oggOpusPlaytimeMs derives duration from the Opus granule (48kHz)', () => {
  const serial = 0x1234;
  // BOS page: first packet is OpusHead (19 bytes).
  const opusHead = Buffer.concat([Buffer.from('OpusHead'), Buffer.alloc(11)]);
  const bos = oggPage(0n, serial, 0, opusHead);
  // Audio page: granule 96000 samples / 48000 = 2000 ms.
  const audio = oggPage(96000n, serial, 1, Buffer.from([0]));
  const ms = oggOpusPlaytimeMs(Buffer.concat([bos, audio]));
  assert.equal(ms, 2000);
});

test('oggOpusPlaytimeMs returns null for non-Ogg input', () => {
  assert.equal(oggOpusPlaytimeMs(Buffer.from('not an ogg file at all')), null);
});

test('oggOpusPlaytimeMs returns null when there is no OpusHead stream', () => {
  // Valid Ogg page but the first packet is not OpusHead.
  const page = oggPage(48000n, 1, 0, Buffer.from('VorbisXX'));
  assert.equal(oggOpusPlaytimeMs(page), null);
});
