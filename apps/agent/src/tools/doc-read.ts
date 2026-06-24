import { Type, type Static } from '@mariozechner/pi-ai';
import { ValidationError } from '@openhermit/shared';
import mammoth from 'mammoth';
import ExcelJS from 'exceljs';
import { extractText, getDocumentProxy, renderPageAsImage } from 'unpdf';
import { createWorker, type Worker } from 'tesseract.js';
import { mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  type PolicyAwareTool,
  type Toolset,
  type ToolContext,
  asTextContent,
  formatJson,
} from './shared.js';

const DocReadParams = Type.Object({
  attachment_id: Type.String({
    description: 'The id of an uploaded document (from `attachment_list`, e.g. `att_xxx`).',
  }),
  max_pages: Type.Optional(
    Type.Number({
      description:
        'For PDFs: max pages to render as images when a page has no extractable text (scanned/image-only pages a multimodal model can still read). Default 5.',
    }),
  ),
});

type DocReadArgs = Static<typeof DocReadParams>;

const MAX_INPUT_BYTES = 20 * 1024 * 1024;
const DEFAULT_MAX_RENDER_PAGES = 5;
// Below this many non-whitespace chars a page is treated as scanned and rendered for vision.
const MIN_TEXT_CHARS_PER_PAGE = 8;
const RENDER_SCALE = 2;
// Bound work on untrusted documents so a huge/malicious file can't tie up the agent.
const MAX_PDF_PAGES = 200;
const MAX_XLSX_SHEETS = 50;
const MAX_XLSX_ROWS_PER_SHEET = 5000;
// Cache Tesseract's downloaded traineddata in a writable temp dir, not the process cwd.
const TESSDATA_CACHE =
  process.env.OPENHERMIT_TESSDATA_CACHE ?? path.join(os.tmpdir(), 'openhermit-tessdata');

const DOCX_MIME =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX_MIME =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const ends = (name: string, ext: string): boolean => name.toLowerCase().endsWith(ext);
const isPdf = (mime: string, name: string): boolean =>
  mime === 'application/pdf' || ends(name, '.pdf');
const isDocx = (mime: string, name: string): boolean =>
  mime === DOCX_MIME || ends(name, '.docx');
const isXlsx = (mime: string, name: string): boolean =>
  mime === XLSX_MIME || ends(name, '.xlsx');
const isImageMime = (mime: string): boolean => mime.startsWith('image/');
const isTextMime = (mime: string): boolean =>
  mime.startsWith('text/') ||
  mime === 'application/json' ||
  mime === 'application/xml' ||
  mime === 'application/x-yaml' ||
  mime === 'application/yaml' ||
  /\+(?:json|xml|yaml)$/.test(mime);

type Block = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };

async function streamToBuffer(stream: NodeJS.ReadableStream, cap: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let seen = 0;
  for await (const chunk of stream) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer);
    seen += buf.length;
    chunks.push(buf);
    if (seen > cap) return Buffer.concat(chunks).subarray(0, cap + 1);
  }
  return Buffer.concat(chunks);
}

const cellToString = (value: unknown): string => {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    const o = value as Record<string, unknown>;
    if (typeof o['text'] === 'string') return o['text'];
    if (o['result'] !== undefined) return String(o['result']);
    if (typeof o['hyperlink'] === 'string') return o['hyperlink'];
    if (Array.isArray(o['richText']))
      return (o['richText'] as Array<{ text?: string }>).map((r) => r.text ?? '').join('');
  }
  return String(value);
};

const csvEscape = (s: string): string =>
  /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;

async function ocrPng(worker: Worker, png: Buffer): Promise<string> {
  // tesseract's ImageLike type omits Node Buffer, which it accepts at runtime.
  const { data } = await worker.recognize(png as unknown as Buffer);
  return data.text.trim();
}

async function createOcrWorker(): Promise<Worker> {
  await mkdir(TESSDATA_CACHE, { recursive: true });
  return createWorker('eng', 1, { cachePath: TESSDATA_CACHE });
}

async function readPdf(
  buf: Buffer,
  maxRenderPages: number,
  ocr: ((png: Buffer) => Promise<string>) | null,
): Promise<Block[]> {
  const pdf = await getDocumentProxy(new Uint8Array(buf));
  try {
    if (pdf.numPages > MAX_PDF_PAGES) {
      return [{
        type: 'text',
        text: `This PDF has ${pdf.numPages} pages, exceeding doc_read's ${MAX_PDF_PAGES}-page limit. Use the sandbox_path with Read/Bash, or extract a smaller page range.`,
      }];
    }
    const { totalPages, text } = await extractText(pdf, { mergePages: false });

    const textParts: string[] = [];
    const scannedPages: number[] = [];
    text.forEach((pageText, i) => {
      const clean = (pageText ?? '').trim();
      if (clean.replace(/\s/g, '').length >= MIN_TEXT_CHARS_PER_PAGE) {
        textParts.push(`--- page ${i + 1} ---\n${clean}`);
      } else {
        scannedPages.push(i + 1);
      }
    });

    const blocks: Block[] = [];
    if (textParts.length > 0) {
      blocks.push({ type: 'text', text: textParts.join('\n\n') });
    }

    let rendered = 0;
    for (const pageNo of scannedPages) {
      if (rendered >= maxRenderPages) break;
      const png = Buffer.from(
        await renderPageAsImage(pdf, pageNo, {
          canvasImport: () => import('@napi-rs/canvas'),
          scale: RENDER_SCALE,
        }),
      );
      if (ocr) {
        const text = await ocr(png);
        blocks.push({ type: 'text', text: `--- page ${pageNo} (OCR) ---\n${text || '(no text found)'}` });
      } else {
        blocks.push({ type: 'image', data: png.toString('base64'), mimeType: 'image/png' });
        blocks.push({ type: 'text', text: `(rendered page ${pageNo} as an image to read)` });
      }
      rendered += 1;
    }

    if (blocks.length === 0) {
      blocks.push({
        type: 'text',
        text: `This PDF has ${totalPages} page(s) but no extractable text, and no pages were rendered (max_pages=${maxRenderPages}).`,
      });
    } else if (scannedPages.length > rendered) {
      blocks.push({
        type: 'text',
        text: `(${scannedPages.length - rendered} more scanned page(s) not rendered; raise max_pages to see them.)`,
      });
    }
    return blocks;
  } finally {
    await pdf.destroy();
  }
}

async function readXlsx(buf: Buffer): Promise<string> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  const sheets: string[] = [];
  let sheetCount = 0;
  wb.eachSheet((ws) => {
    if (sheetCount >= MAX_XLSX_SHEETS) return;
    sheetCount += 1;
    const lines: string[] = [];
    let rows = 0;
    let truncated = false;
    ws.eachRow({ includeEmpty: false }, (row) => {
      if (rows >= MAX_XLSX_ROWS_PER_SHEET) { truncated = true; return; }
      rows += 1;
      const values = Array.isArray(row.values) ? row.values.slice(1) : [];
      lines.push(values.map((v) => csvEscape(cellToString(v))).join(','));
    });
    if (truncated) lines.push(`… (truncated at ${MAX_XLSX_ROWS_PER_SHEET} rows)`);
    sheets.push(`### ${ws.name}\n${lines.join('\n')}`);
  });
  if (wb.worksheets.length > MAX_XLSX_SHEETS) {
    sheets.push(`(… ${wb.worksheets.length - MAX_XLSX_SHEETS} more sheet(s) not shown)`);
  }
  return sheets.join('\n\n');
}

export const createDocReadTool = (
  context: ToolContext,
): PolicyAwareTool<typeof DocReadParams> => ({
  policy: { defaultGrants: [{ type: 'any' }] },
  name: 'doc_read',
  // Heavy parsing on untrusted bytes — never run concurrently with other tool calls.
  executionMode: 'sequential',
  label: 'Read Document',
  description:
    'Extract the contents of an uploaded document into the model context. Handles PDF, Word (.docx) and Excel (.xlsx) by pulling out their text, spreadsheets as CSV, and images directly. Scanned/image-only PDF pages are rendered to images so a multimodal model can read them. For plain text/code/JSON or other files, prefer attachment_fetch.',
  parameters: DocReadParams,
  execute: async (_toolCallId, args: DocReadArgs) => {
    if (!context.attachmentStore || !context.attachmentStorage || !context.storeScope) {
      throw new ValidationError('doc_read is unavailable: attachment storage is not configured.');
    }
    const id = args.attachment_id.trim();
    if (!id) {
      throw new ValidationError('doc_read requires a non-empty attachment_id.');
    }

    const row = await context.attachmentStore.get(id);
    if (!row || row.agentId !== context.storeScope.agentId) {
      throw new ValidationError(`doc_read: no such attachment ${id}.`);
    }
    const sameSession = row.sessionId === context.sessionId;
    const isOwner = context.currentUserRole === 'owner';
    const isUploader = !!row.uploaderUserId && row.uploaderUserId === context.currentUserId;
    if (!sameSession && !isOwner && !isUploader) {
      throw new ValidationError(`doc_read: attachment ${id} is not visible in this session.`);
    }

    const name = row.originalName ?? '';
    const mime = row.mimeType ?? 'application/octet-stream';
    const summary = {
      id: row.id,
      name: row.originalName,
      mime,
      size: row.sizeBytes,
      sandboxPath: row.sandboxPath,
    };

    if (row.sizeBytes > MAX_INPUT_BYTES) {
      return {
        content: asTextContent(
          formatJson({
            ...summary,
            note: `file is ${row.sizeBytes} bytes which exceeds doc_read's ${MAX_INPUT_BYTES}-byte limit. Use the sandbox_path with Read/Bash, or split the document.`,
          }),
        ),
        details: { id: row.id, kind: 'oversize', size: row.sizeBytes },
      };
    }

    const stream = await context.attachmentStorage.readStream(row.storageKey);
    const buf = await streamToBuffer(stream, MAX_INPUT_BYTES);
    const maxRenderPages = Math.max(0, Math.floor(args.max_pages ?? DEFAULT_MAX_RENDER_PAGES));

    // Text-only models can't read image blocks, so OCR image-bearing content to
    // text instead. The worker is created on first use and torn down after.
    const textOnly = context.modelSupportsImageInput === false;
    let worker: Worker | null = null;
    const ocr = textOnly
      ? async (png: Buffer): Promise<string> => {
          worker ??= await createOcrWorker();
          return ocrPng(worker, png);
        }
      : null;

    try {
      if (isPdf(mime, name)) {
        const blocks = await readPdf(buf, maxRenderPages, ocr);
        return { content: blocks, details: { id: row.id, kind: 'pdf' } };
      }
      if (isDocx(mime, name)) {
        const { value } = await mammoth.extractRawText({ buffer: buf as unknown as Buffer });
        return {
          content: asTextContent(value.trim() || '(docx has no extractable text)'),
          details: { id: row.id, kind: 'docx', chars: value.length },
        };
      }
      if (isXlsx(mime, name)) {
        const text = await readXlsx(buf);
        return {
          content: asTextContent(text || '(xlsx has no rows)'),
          details: { id: row.id, kind: 'xlsx' },
        };
      }
      if (isImageMime(mime)) {
        if (ocr) {
          const text = await ocr(buf);
          return {
            content: asTextContent(text || `(no text found in image ${name})`),
            details: { id: row.id, kind: 'image-ocr', mimeType: mime },
          };
        }
        return {
          content: [
            { type: 'image' as const, data: buf.toString('base64'), mimeType: mime },
            { type: 'text' as const, text: `(image: ${name})` },
          ],
          details: { id: row.id, kind: 'image', mimeType: mime },
        };
      }
      if (isTextMime(mime)) {
        return {
          content: asTextContent(buf.toString('utf8')),
          details: { id: row.id, kind: 'text', size: buf.length },
        };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: asTextContent(
          formatJson({ ...summary, error: `failed to extract: ${msg}. Try the sandbox_path with Read/Bash.` }),
        ),
        details: { id: row.id, kind: 'extract-error' },
      };
    } finally {
      if (worker) await (worker as Worker).terminate();
    }

    return {
      content: asTextContent(
        formatJson({
          ...summary,
          note: `doc_read does not handle mime ${mime}. Use attachment_fetch, or the sandbox_path with Read/Bash (or convert it first).`,
        }),
      ),
      details: { id: row.id, kind: 'unsupported', mimeType: mime },
    };
  },
});

const DOC_TOOLSET_DESCRIPTION = `\
### Documents

\`doc_read\` extracts the contents of an uploaded document into the model context: PDF and Word (.docx) as text, Excel (.xlsx) as CSV, and images directly. Scanned/image-only PDF pages are rendered to images for a multimodal model to read. Pass an \`attachment_id\` from \`attachment_list\`. For plain text/code or other formats, use \`attachment_fetch\`.`;

export const createDocToolset = (context: ToolContext): Toolset => ({
  id: 'doc',
  description: DOC_TOOLSET_DESCRIPTION,
  tools: [createDocReadTool(context)],
});
