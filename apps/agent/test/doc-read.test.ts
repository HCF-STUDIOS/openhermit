import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import zlib from 'node:zlib';

import { createCanvas } from '@napi-rs/canvas';

import { createDocReadTool } from '../src/tools/doc-read.js';
import type { ToolContext } from '../src/tools/shared.js';

const DOCX_MIME =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

// Tiny 1x1 PNG (same bytes used by prepare-attachment-content.test.ts).
const PNG_BYTES = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4' +
    '890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082',
  'hex',
);

// Build a minimal, valid single-page PDF with the given content stream so we
// don't need a PDF writer dependency. Offsets are computed so pdf.js parses it.
function makePdf(streamContent: string): Buffer {
  const objs = [
    `<</Type/Catalog/Pages 2 0 R>>`,
    `<</Type/Pages/Kids[3 0 R]/Count 1>>`,
    `<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>`,
    `<</Length ${Buffer.byteLength(streamContent, 'latin1')}>>\nstream\n${streamContent}\nendstream`,
    `<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((body, i) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<</Size ${objs.length + 1}/Root 1 0 R>>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(pdf, 'latin1');
}

// A single-page PDF whose only content is a JPEG covering the page — what a
// real scan looks like. Rendering one needs pdf.js to have a working canvas
// factory for image decoding, which makePdf's text-only pages never exercise.
function makeScanPdf(label: string, w = 300, h = 200): Buffer {
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#000000';
  ctx.font = `${Math.round(h / 6)}px sans-serif`;
  ctx.fillText(label, 20, h / 2);
  const jpg = canvas.toBuffer('image/jpeg', 90);

  const content = `q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`;
  const head = [
    `<</Type/Catalog/Pages 2 0 R>>`,
    `<</Type/Pages/Kids[3 0 R]/Count 1>>`,
    `<</Type/Page/Parent 2 0 R/MediaBox[0 0 ${w} ${h}]/Contents 4 0 R/Resources<</XObject<</Im0 5 0 R>>>>>>`,
    `<</Length ${content.length}>>\nstream\n${content}\nendstream`,
  ];
  const parts: Buffer[] = [Buffer.from('%PDF-1.4\n', 'latin1')];
  const offsets: number[] = [];
  let len = parts[0]!.length;
  const push = (b: Buffer): void => {
    parts.push(b);
    len += b.length;
  };
  head.forEach((body, i) => {
    offsets.push(len);
    push(Buffer.from(`${i + 1} 0 obj\n${body}\nendobj\n`, 'latin1'));
  });
  offsets.push(len);
  push(
    Buffer.from(
      `5 0 obj\n<</Type/XObject/Subtype/Image/Width ${w}/Height ${h}/ColorSpace/DeviceRGB/BitsPerComponent 8/Filter/DCTDecode/Length ${jpg.length}>>\nstream\n`,
      'latin1',
    ),
  );
  push(jpg);
  push(Buffer.from('\nendstream\nendobj\n', 'latin1'));

  const xrefOffset = len;
  let tail = `xref\n0 6\n0000000000 65535 f \n`;
  for (const off of offsets) tail += `${String(off).padStart(10, '0')} 00000 n \n`;
  tail += `trailer\n<</Size 6/Root 1 0 R>>\nstartxref\n${xrefOffset}\n%%EOF`;
  push(Buffer.from(tail, 'latin1'));
  return Buffer.concat(parts);
}

// A 2-page PDF: page 1 has real extractable text, page 2 draws a real JPEG
// through an XObject that lies about its dimensions (declares a 100000000 x
// 100000000 image). unpdf's canvas backend rejects allocating a surface that
// large ("Create skia surface failed"), which is a real, deterministic throw
// out of renderPageAsImage — the "one corrupt scanned page among otherwise
// good pages" case. (A JPEG with a garbled byte stream doesn't reproduce
// this: pdf.js just logs a decode warning and renders the page blank.)
function makeMixedFailurePdf(text: string, w = 300, h = 200): Buffer {
  const jpg = createCanvas(10, 10).toBuffer('image/jpeg', 90);
  const textContent = `BT /F1 24 Tf 36 120 Td (${text}) Tj ET`;
  const imgContent = `q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`;
  const lyingDim = 100_000_000;

  const objs: Array<{ num: number; body: Buffer }> = [];
  const add = (num: number, body: string | Buffer): void => {
    objs.push({ num, body: Buffer.isBuffer(body) ? body : Buffer.from(body, 'latin1') });
  };

  add(1, `<</Type/Catalog/Pages 2 0 R>>`);
  add(2, `<</Type/Pages/Kids[3 0 R 4 0 R]/Count 2>>`);
  add(
    3,
    `<</Type/Page/Parent 2 0 R/MediaBox[0 0 ${w} ${h}]/Contents 5 0 R/Resources<</Font<</F1 7 0 R>>>>>>`,
  );
  add(
    4,
    `<</Type/Page/Parent 2 0 R/MediaBox[0 0 ${w} ${h}]/Contents 6 0 R/Resources<</XObject<</Im0 8 0 R>>>>>>`,
  );
  add(5, `<</Length ${Buffer.byteLength(textContent, 'latin1')}>>\nstream\n${textContent}\nendstream`);
  add(6, `<</Length ${imgContent.length}>>\nstream\n${imgContent}\nendstream`);
  add(7, `<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>`);
  add(
    8,
    Buffer.concat([
      Buffer.from(
        `<</Type/XObject/Subtype/Image/Width ${lyingDim}/Height ${lyingDim}/ColorSpace/DeviceRGB/BitsPerComponent 8/Filter/DCTDecode/Length ${jpg.length}>>\nstream\n`,
        'latin1',
      ),
      jpg,
      Buffer.from('\nendstream', 'latin1'),
    ]),
  );

  const parts: Buffer[] = [Buffer.from('%PDF-1.4\n', 'latin1')];
  let len = parts[0]!.length;
  const offsets: number[] = [];
  for (const { num, body } of objs) {
    offsets.push(len);
    const wrapped = Buffer.concat([
      Buffer.from(`${num} 0 obj\n`, 'latin1'),
      body,
      Buffer.from('\nendobj\n', 'latin1'),
    ]);
    parts.push(wrapped);
    len += wrapped.length;
  }
  const xrefOffset = len;
  let tail = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) tail += `${String(off).padStart(10, '0')} 00000 n \n`;
  tail += `trailer\n<</Size ${objs.length + 1}/Root 1 0 R>>\nstartxref\n${xrefOffset}\n%%EOF`;
  parts.push(Buffer.from(tail, 'latin1'));
  return Buffer.concat(parts);
}

// Minimal ZIP reader/writer (STORE method, no compression) built on node:zlib
// alone. docx/pptx are ZIP containers; this lets a test rewrite one asset
// (swap in an oversized image) without a zip library dependency.
function readZipEntries(buf: Buffer): Map<string, Buffer> {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip: no end-of-central-directory record');
  const entryCount = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  const out = new Map<string, Buffer>();
  let p = cdOffset;
  for (let i = 0; i < entryCount; i++) {
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const lfNameLen = buf.readUInt16LE(localOffset + 26);
    const lfExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lfNameLen + lfExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);
    out.set(name, method === 0 ? Buffer.from(raw) : zlib.inflateRawSync(raw));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function writeZipStore(entries: Array<{ name: string; data: Buffer }>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    localParts.push(local, nameBuf, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBuf);

    offset += local.length + nameBuf.length + data.length;
  }
  const localBuf = Buffer.concat(localParts);
  const centralBuf = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(localBuf.length, 16);
  return Buffer.concat([localBuf, centralBuf, eocd]);
}

// Swaps sample-with-image.docx's embedded picture for a >2MB one (random
// per-pixel noise so it doesn't compress away) to exercise the per-image size
// cap through the real anydoc asset path, not a mocked one.
function makeDocxWithOversizedImage(): Buffer {
  const original = readFileSync(new URL('./fixtures/sample-with-image.docx', import.meta.url));
  const entries = readZipEntries(original);

  const size = 900;
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');
  const noise = ctx.createImageData(size, size);
  for (let i = 0; i < noise.data.length; i++) noise.data[i] = Math.floor(Math.random() * 256);
  ctx.putImageData(noise, 0, 0);
  const bigPng = canvas.toBuffer('image/png');

  entries.set('word/media/rId9.png', bigPng);
  return writeZipStore([...entries.entries()].map(([name, data]) => ({ name, data })));
}

function ctxFor(bytes: Buffer, mimeType: string, name: string): ToolContext {
  const row = {
    id: 'att_1',
    agentId: 'agent_1',
    sessionId: 'sess_1',
    originalName: name,
    mimeType,
    sizeBytes: bytes.length,
    storageKey: 'key_1',
    uploaderUserId: 'user_1',
    sandboxPath: `/root/.openhermit/attachments/sess_1/att_1/${name}`,
  };
  return {
    sessionId: 'sess_1',
    currentUserRole: 'owner',
    storeScope: { agentId: 'agent_1' },
    attachmentStore: { get: async (id: string) => (id === 'att_1' ? row : null) },
    attachmentStorage: { readStream: async () => Readable.from(bytes) },
  } as unknown as ToolContext;
}

const run = (ctx: ToolContext, args: Record<string, unknown>) =>
  createDocReadTool(ctx).execute('call_1', args as never) as Promise<{
    content: Array<{ type: string; text?: string }>;
    details: { kind?: string };
  }>;

const textOf = (content: Array<{ type: string; text?: string }>): string =>
  content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n');

test('doc_read extracts text from a PDF', async () => {
  const pdf = makePdf('BT /F1 24 Tf 36 120 Td (HELLO DOC_READ) Tj ET');
  const res = await run(ctxFor(pdf, 'application/pdf', 'a.pdf'), { attachment_id: 'att_1' });
  assert.equal(res.details.kind, 'pdf');
  assert.match(textOf(res.content), /HELLO DOC_READ/);
});

test('doc_read renders a scanned PDF page to an image for vision', async () => {
  // The page has to carry a real raster image: pdf.js needs a working canvas
  // factory to decode one, and a blank page passes even when that is broken.
  const pdf = makeScanPdf('SCANNED PAGE');
  const res = await run(ctxFor(pdf, 'application/pdf', 'scan.pdf'), { attachment_id: 'att_1' });
  assert.equal(res.details.kind, 'pdf');
  assert.ok(
    res.content.some((b) => b.type === 'image'),
    `an image-only page must render, got: ${textOf(res.content).slice(0, 200)}`,
  );
});

test('doc_read reads a .docx into text', async () => {
  const docx = readFileSync(new URL('./fixtures/sample.docx', import.meta.url));
  const res = await run(
    ctxFor(
      docx,
      DOCX_MIME,
      'sample.docx',
    ),
    { attachment_id: 'att_1' },
  );
  assert.equal(res.details.kind, 'docx');
  assert.match(textOf(res.content), /HELLO FROM DOCX/);
});

test('doc_read surfaces images embedded in a document', async () => {
  // Markdown keeps only the alt text, so the bytes have to come off anydoc's
  // document model or a chart-heavy report reaches the model as prose alone.
  const docx = readFileSync(new URL('./fixtures/sample-with-image.docx', import.meta.url));
  const res = await run(ctxFor(docx, DOCX_MIME, 'chart.docx'), { attachment_id: 'att_1' });
  assert.equal(res.details.kind, 'docx');
  assert.match(textOf(res.content), /Doc with image/);
  assert.ok(
    res.content.some((b) => b.type === 'image'),
    'the embedded image should reach the model as an image block',
  );
});

test('doc_read honours max_pages when pulling embedded images', async () => {
  const docx = readFileSync(new URL('./fixtures/sample-with-image.docx', import.meta.url));
  const res = await run(ctxFor(docx, DOCX_MIME, 'chart.docx'), {
    attachment_id: 'att_1',
    max_pages: 0,
  });
  assert.ok(
    !res.content.some((b) => b.type === 'image'),
    'max_pages=0 must suppress embedded images',
  );
  assert.match(textOf(res.content), /Doc with image/, 'text must still come through');
});

test('doc_read reads an .xlsx as a markdown table', async () => {
  const xlsx = readFileSync(new URL('./fixtures/sample.xlsx', import.meta.url));
  const res = await run(
    ctxFor(
      xlsx,
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'data.xlsx',
    ),
    { attachment_id: 'att_1' },
  );
  assert.equal(res.details.kind, 'xlsx');
  const text = textOf(res.content);
  assert.match(text, /\|\s*Name\s*\|\s*Score\s*\|/);
  assert.match(text, /\|\s*Alice\s*\|\s*42\s*\|/);
});

test('doc_read reads an .rtf, a format the old parsers did not handle', async () => {
  const rtf = Buffer.from(
    '{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Helvetica;}}\\f0\\fs24 HELLO FROM RTF\\par}',
    'latin1',
  );
  const res = await run(ctxFor(rtf, 'application/rtf', 'note.rtf'), { attachment_id: 'att_1' });
  assert.equal(res.details.kind, 'rtf');
  assert.match(textOf(res.content), /HELLO FROM RTF/);
});

// The mime type is a lie here; anydoc reads the container signature instead.
test('doc_read detects the format from the bytes, not the declared mime', async () => {
  const docx = readFileSync(new URL('./fixtures/sample.docx', import.meta.url));
  const res = await run(ctxFor(docx, 'application/octet-stream', 'mystery.bin'), {
    attachment_id: 'att_1',
  });
  assert.equal(res.details.kind, 'docx');
  assert.match(textOf(res.content), /HELLO FROM DOCX/);
});

test('doc_read returns an image block for an image attachment', async () => {
  const res = await run(ctxFor(PNG_BYTES, 'image/png', 'pic.png'), { attachment_id: 'att_1' });
  assert.equal(res.details.kind, 'image');
  assert.ok(res.content.some((b) => b.type === 'image'));
});

test('doc_read points unsupported binaries at the sandbox path', async () => {
  const res = await run(
    ctxFor(Buffer.from([0, 1, 2, 3]), 'application/octet-stream', 'blob.bin'),
    { attachment_id: 'att_1' },
  );
  assert.equal(res.details.kind, 'unsupported');
  assert.match(textOf(res.content), /sandbox/i);
});

test('doc_read rejects an unknown attachment id', async () => {
  await assert.rejects(
    run(ctxFor(PNG_BYTES, 'image/png', 'pic.png'), { attachment_id: 'nope' }),
    /no such attachment/,
  );
});

// A PNG containing rendered text, so OCR has something real to read.
function pngWithText(text: string): Buffer {
  const canvas = createCanvas(360, 120);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 360, 120);
  ctx.fillStyle = '#000000';
  ctx.font = '48px sans-serif';
  ctx.fillText(text, 20, 75);
  return canvas.toBuffer('image/png');
}

test('doc_read does not return image blocks for a scanned PDF when the model is text-only', { timeout: 120_000 }, async () => {
  const pdf = makeScanPdf('OCR THE PAGE', 720, 240);
  const ctx = ctxFor(pdf, 'application/pdf', 'scan.pdf');
  (ctx as { modelSupportsImageInput?: boolean }).modelSupportsImageInput = false;
  const res = await run(ctx, { attachment_id: 'att_1' });
  assert.equal(res.details.kind, 'pdf');
  assert.ok(
    !res.content.some((b) => b.type === 'image'),
    'text-only must OCR scanned pages to text, not return image blocks',
  );
  const text = textOf(res.content);
  assert.match(text, /\(OCR\)/, 'text-only must produce an OCR text block for the scanned page');
  assert.match(text.toUpperCase(), /OCR THE PAGE/, 'OCR must recover the page content');
});

test('doc_read OCRs an image to text when the model is text-only', { timeout: 120_000 }, async () => {
  const png = pngWithText('OCR WORKS 123');
  const ctx = ctxFor(png, 'image/png', 'scan.png');
  (ctx as { modelSupportsImageInput?: boolean }).modelSupportsImageInput = false;
  const res = await run(ctx, { attachment_id: 'att_1' });
  assert.equal(res.details.kind, 'image-ocr');
  assert.ok(!res.content.some((b) => b.type === 'image'), 'text-only must not return an image block');
  assert.match(textOf(res.content).toUpperCase(), /OCR WORKS/);
});

test('doc_read bounds the rendered image size for a large-format page', async () => {
  // 3000x4000pt page: at the old fixed scale=2 this would render 6000x8000px.
  const pdf = makeScanPdf('BIG', 3000, 4000);
  const res = await run(ctxFor(pdf, 'application/pdf', 'poster.pdf'), { attachment_id: 'att_1' });
  const img = res.content.find((b) => b.type === 'image') as { data: string } | undefined;
  assert.ok(img, 'large scanned page should still render an image');
  const png = Buffer.from(img.data, 'base64');
  const width = png.readUInt32BE(16); // PNG IHDR width
  const height = png.readUInt32BE(20); // PNG IHDR height
  assert.ok(
    Math.max(width, height) <= 2200,
    `rendered long edge ${Math.max(width, height)}px should be capped at RENDER_MAX_DIM (2200)`,
  );
});

test('doc_read keeps text from good pages when one scanned page fails to render', async () => {
  const pdf = makeMixedFailurePdf('GOOD PAGE TEXT');
  const res = await run(ctxFor(pdf, 'application/pdf', 'mixed.pdf'), { attachment_id: 'att_1' });
  assert.equal(res.details.kind, 'pdf');
  const text = textOf(res.content);
  assert.match(text, /GOOD PAGE TEXT/, 'text from the good page must survive the other page failing');
  assert.match(text, /could not render this scanned page/, 'the failed page should get a note, not vanish');
  assert.ok(!res.content.some((b) => b.type === 'image'), 'the failed page must not produce an image block');
});

test('doc_read skips embedded images over the per-image size cap', async () => {
  const docx = makeDocxWithOversizedImage();
  const res = await run(ctxFor(docx, DOCX_MIME, 'big-image.docx'), { attachment_id: 'att_1' });
  assert.equal(res.details.kind, 'docx');
  assert.ok(
    !res.content.some((b) => b.type === 'image'),
    'an oversized embedded image must not reach the model as an image block',
  );
  assert.match(textOf(res.content), /skipped as too large/, 'the model should be told an image was skipped');
  assert.match(textOf(res.content), /Doc with image/, 'the surrounding text must still come through');
});

test('doc_read records how long the PDF parse blocked', async () => {
  const { pdfParseDurationMs } = await import('../src/metrics.js');
  // prom-client's get() is async and returns { values: [...] }; the observation
  // count lives in the entry whose metricName ends in `_count`.
  const countOf = async (): Promise<number> =>
    (await pdfParseDurationMs.get()).values.find((v) =>
      v.metricName?.endsWith('_count'),
    )?.value ?? 0;

  const before = await countOf();
  const pdf = makePdf('BT /F1 24 Tf 36 120 Td (TIMED) Tj ET');
  await run(ctxFor(pdf, 'application/pdf', 'a.pdf'), { attachment_id: 'att_1' });

  assert.equal(await countOf(), before + 1, 'the PDF parse should be observed once');
});

test('doc_read extracts cell sources from a Jupyter notebook', async () => {
  const nb = Buffer.from(
    JSON.stringify({
      cells: [
        { cell_type: 'markdown', source: ['# Title\n', 'some notes'] },
        { cell_type: 'code', source: 'print("hello notebook")', outputs: [{ data: { 'image/png': 'BIGBASE64' } }] },
      ],
    }),
  );
  const res = await run(ctxFor(nb, 'application/x-ipynb+json', 'analysis.ipynb'), { attachment_id: 'att_1' });
  assert.equal(res.details.kind, 'ipynb');
  const text = textOf(res.content);
  assert.match(text, /# Title/);
  assert.match(text, /print\("hello notebook"\)/);
  assert.doesNotMatch(text, /BIGBASE64/, 'notebook outputs must be stripped, only cell sources kept');
});
