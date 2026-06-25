import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { test } from 'node:test';

import ExcelJS from 'exceljs';
import { createCanvas } from '@napi-rs/canvas';

import { createDocReadTool } from '../src/tools/doc-read.js';
import type { ToolContext } from '../src/tools/shared.js';

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

test('doc_read renders a text-less (scanned) PDF page to an image for vision', async () => {
  const pdf = makePdf(' '); // no text operators -> treated as scanned -> rendered
  const res = await run(ctxFor(pdf, 'application/pdf', 'scan.pdf'), { attachment_id: 'att_1' });
  assert.equal(res.details.kind, 'pdf');
  assert.ok(
    res.content.some((b) => b.type === 'image'),
    'a scanned PDF page should be rendered to an image block',
  );
});

test('doc_read reads a .docx into text', async () => {
  const docx = readFileSync(new URL('./fixtures/sample.docx', import.meta.url));
  const res = await run(
    ctxFor(
      docx,
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'sample.docx',
    ),
    { attachment_id: 'att_1' },
  );
  assert.equal(res.details.kind, 'docx');
  assert.match(textOf(res.content), /HELLO FROM DOCX/);
});

test('doc_read reads an .xlsx as CSV', async () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  ws.addRow(['Name', 'Score']);
  ws.addRow(['Alice', 42]);
  const xlsx = Buffer.from(await wb.xlsx.writeBuffer());
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
  assert.match(text, /Name,Score/);
  assert.match(text, /Alice,42/);
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
  const pdf = makePdf(' '); // no text layer -> scanned -> would render an image for vision
  const ctx = ctxFor(pdf, 'application/pdf', 'scan.pdf');
  (ctx as { modelSupportsImageInput?: boolean }).modelSupportsImageInput = false;
  const res = await run(ctx, { attachment_id: 'att_1' });
  assert.equal(res.details.kind, 'pdf');
  assert.ok(
    !res.content.some((b) => b.type === 'image'),
    'text-only must OCR scanned pages to text, not return image blocks',
  );
  assert.ok(
    res.content.some((b) => b.type === 'text' && (b.text ?? '').includes('(OCR)')),
    'text-only must produce an OCR text block for the scanned page',
  );
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
