import { Type, type Static } from '@mariozechner/pi-ai';
import { ValidationError } from '@openhermit/shared';
import { formatFromBytes, formatFromPath, toDocument, toMarkdownBytes, type Format } from '@firecrawl/anydoc';
import { classifyPdf, extractPagesMarkdown } from '@firecrawl/pdf-inspector';
import { createIsomorphicCanvasFactory, getDocumentProxy, renderPageAsImage } from 'unpdf';
import type { Worker } from 'tesseract.js';
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
        'Max images to pull into context: PDF pages with no extractable text (scanned/image-only) and images embedded in a document. Default 5.',
    }),
  ),
});

type DocReadArgs = Static<typeof DocReadParams>;

const MAX_INPUT_BYTES = 20 * 1024 * 1024;
const DEFAULT_MAX_RENDER_PAGES = 5;
const RENDER_SCALE = 2;
const RENDER_MAX_DIM = 2200;
const MAX_PDF_PAGES = 200;
const MAX_RENDER_PAGES = 10;
const TESSDATA_CACHE = path.join(os.tmpdir(), 'openhermit-tessdata');

// anydoc reads the signature each container specification designates, so a
// mislabelled mime type doesn't matter; the extension is only the fallback for
// signature-less formats. Widened to string so we can compare it to literals.
const detectFormat = (buf: Buffer, name: string): string | null =>
  formatFromBytes(buf) ?? formatFromPath(name);

const isNotebook = (mime: string, name: string): boolean =>
  mime === 'application/x-ipynb+json' || name.toLowerCase().endsWith('.ipynb');
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

async function ocrPng(worker: Worker, png: Buffer): Promise<string> {
  // tesseract's ImageLike type omits Node Buffer, which it accepts at runtime.
  const { data } = await worker.recognize(png as unknown as Buffer);
  return data.text.trim();
}

type CanvasImport = NonNullable<
  NonNullable<Parameters<typeof renderPageAsImage>[2]>['canvasImport']
>;
async function loadCanvasImport(): Promise<CanvasImport | null> {
  try {
    await import('@napi-rs/canvas');
    return () => import('@napi-rs/canvas');
  } catch {
    return null;
  }
}

const OCR_NOTE =
  '(OCR ran on this document; tesseract.js downloaded its English language data over the network once and cached it locally for next time.)';

async function createOcrWorker(): Promise<Worker> {
  const { createWorker } = await import('tesseract.js');
  await mkdir(TESSDATA_CACHE, { recursive: true });
  // tesseract downloads eng.traineddata (~5MB) from its CDN on first use, then
  // caches it under TESSDATA_CACHE. OCR needs network once; not air-gapped.
  return createWorker('eng', 1, { cachePath: TESSDATA_CACHE });
}

async function readPdf(
  buf: Buffer,
  maxRenderPages: number,
  ocr: ((png: Buffer) => Promise<string | null>) | null,
  canvasImport: CanvasImport | null,
): Promise<Block[]> {
  // pdf-inspector is a synchronous native binding; it blocks the event loop for
  // the parse. ponytail: fine at doc_read's 20MB / 200-page ceiling (tens of ms);
  // move it to a worker thread if bigger documents ever get through.
  const { pageCount } = classifyPdf(buf);
  if (pageCount > MAX_PDF_PAGES) {
    return [{
      type: 'text',
      text: `This PDF has ${pageCount} pages, exceeding doc_read's ${MAX_PDF_PAGES}-page limit. Use the sandbox_path with Read/Bash, or extract a smaller page range.`,
    }];
  }

  // needsOcr is pdf-inspector's own verdict on the text layer (empty, GID-encoded
  // fonts, garbage), so it replaces the old "did we get enough characters?" guess.
  const textParts: string[] = [];
  const scannedPages: number[] = [];
  for (const page of extractPagesMarkdown(buf).pages) {
    const pageNo = page.page + 1; // pdf-inspector reports 0-indexed pages here
    const clean = page.markdown.trim();
    if (page.needsOcr) scannedPages.push(pageNo);
    else if (clean) textParts.push(`--- page ${pageNo} ---\n${clean}`);
    // else: a genuinely blank page — nothing to show and nothing to render.
  }

  const blocks: Block[] = [];
  if (textParts.length > 0) {
    blocks.push({ type: 'text', text: textParts.join('\n\n') });
  }

  // pdf-inspector doesn't rasterise, so pages it flags for OCR still go through
  // pdf.js. Only opened when there is actually something to render.
  let rendered = 0;
  if (canvasImport && maxRenderPages > 0 && scannedPages.length > 0) {
    // The factory has to go on the proxy: unpdf only attaches its own when
    // renderPageAsImage opens the document, and pdf.js needs a working one to
    // decode raster images — i.e. every page worth rendering here.
    const CanvasFactory = await createIsomorphicCanvasFactory(canvasImport);
    const pdf = await getDocumentProxy(new Uint8Array(buf), { CanvasFactory });
    try {
      for (const pageNo of scannedPages) {
        if (rendered >= maxRenderPages) break;
        const vp = (await pdf.getPage(pageNo)).getViewport({ scale: 1 });
        const scale = Math.min(RENDER_SCALE, RENDER_MAX_DIM / Math.max(vp.width, vp.height));
        const png = Buffer.from(
          await renderPageAsImage(pdf, pageNo, { canvasImport, scale }),
        );
        if (ocr) {
          const text = await ocr(png);
          if (text === null) {
            // text-only model + OCR backend unavailable
            blocks.push({ type: 'text', text: `--- page ${pageNo} ---\n(scanned page; OCR is unavailable in this build)` });
          } else {
            blocks.push({ type: 'text', text: `--- page ${pageNo} (OCR) ---\n${text || '(no text found)'}` });
          }
        } else {
          blocks.push({ type: 'image', data: png.toString('base64'), mimeType: 'image/png' });
          blocks.push({ type: 'text', text: `(rendered page ${pageNo} as an image to read)` });
        }
        rendered += 1;
      }
    } finally {
      await pdf.destroy();
    }
  }

  if (blocks.length === 0) {
    blocks.push({
      type: 'text',
      text: canvasImport
        ? `This PDF has ${pageCount} page(s) but no extractable text, and no pages were rendered (max_pages=${maxRenderPages}).`
        : `This PDF has ${pageCount} page(s) of scanned/image-only content, but PDF page rendering is unavailable in this build (the @napi-rs/canvas backend isn't installed). Use the sandbox_path with Read/Bash.`,
    });
  } else if (scannedPages.length > rendered) {
    const more = scannedPages.length - rendered;
    blocks.push({
      type: 'text',
      text: canvasImport
        ? `(${more} more scanned page(s) not rendered; raise max_pages to see them.)`
        : `(${more} scanned page(s) not rendered; PDF page rendering is unavailable in this build.)`,
    });
  }
  return blocks;
}

// Markdown can't carry bytes, so anydoc leaves embedded images as alt text and
// keeps the bytes on the document model. A deck or a report is mostly those
// images, so pull them back out — as image blocks, or OCR'd for a text-only model.
async function readOfficeDoc(
  buf: Buffer,
  format: Format,
  maxImages: number,
  ocr: ((png: Buffer) => Promise<string | null>) | null,
): Promise<Block[]> {
  const markdown = (await toMarkdownBytes(buf, format)).trim();
  const blocks: Block[] = [
    { type: 'text', text: markdown || `(${format} has no extractable text)` },
  ];
  if (maxImages <= 0) return blocks;

  // Second parse: anydoc has no single call returning markdown and assets both.
  const assets = (await toDocument(buf, format)).assets.filter((a) =>
    a.mediaType.startsWith('image/'),
  );
  for (const asset of assets.slice(0, maxImages)) {
    if (ocr) {
      const text = await ocr(asset.data);
      if (text) blocks.push({ type: 'text', text: `--- embedded image (OCR) ---\n${text}` });
      continue;
    }
    blocks.push({ type: 'image', data: asset.data.toString('base64'), mimeType: asset.mediaType });
  }
  if (assets.length > maxImages) {
    blocks.push({
      type: 'text',
      text: `(${assets.length - maxImages} more embedded image(s) not shown; raise max_pages to see them.)`,
    });
  }
  return blocks;
}

const nbSource = (src: unknown): string =>
  typeof src === 'string'
    ? src
    : Array.isArray(src)
      ? src.filter((s): s is string => typeof s === 'string').join('')
      : '';

// .ipynb is JSON; dumping it raw floods the context with base64 outputs and
// metadata, so pull out just the cell sources (like Jupyter's nbconvert).
function readNotebook(buf: Buffer): string {
  const nb = JSON.parse(buf.toString('utf8')) as {
    cells?: unknown[];
    worksheets?: Array<{ cells?: unknown[] }>;
  };
  const cells = Array.isArray(nb.cells)
    ? nb.cells
    : (nb.worksheets ?? []).flatMap((ws) => ws?.cells ?? []);
  const labels: Record<string, string> = { markdown: 'Markdown', code: 'Code', raw: 'Raw' };
  const out: string[] = [];
  for (const cell of cells as Array<{ cell_type?: string; source?: unknown }>) {
    const label = labels[cell?.cell_type ?? ''];
    if (label) out.push(`--- ${label} cell ---\n${nbSource(cell.source).replace(/\n+$/, '')}`);
  }
  return out.join('\n\n').trim();
}

export const createDocReadTool = (
  context: ToolContext,
): PolicyAwareTool<typeof DocReadParams> => ({
  policy: { defaultGrants: [{ type: 'any' }] },
  name: 'doc_read',
  executionMode: 'sequential',
  label: 'Read Document',
  description:
    'Extract the contents of an uploaded document into the model context as Markdown. Handles PDF, Word (.doc/.docx), Excel (.xls/.xlsx), PowerPoint (.ppt/.pptx), OpenDocument (.odt/.ods/.odp), RTF, EPUB, Jupyter notebooks (.ipynb) and images. Images embedded in a document, and scanned/image-only PDF pages, are returned as images so a multimodal model can read them. For plain text/code/JSON or other files, prefer attachment_fetch.',
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
    // row.sizeBytes can lie; streamToBuffer returns cap+1 on overrun — reject oversize.
    if (buf.length > MAX_INPUT_BYTES) {
      return {
        content: asTextContent(
          formatJson({
            ...summary,
            note: `file is over ${buf.length} bytes which exceeds doc_read's ${MAX_INPUT_BYTES}-byte limit. Use the sandbox_path with Read/Bash, or split the document.`,
          }),
        ),
        details: { id: row.id, kind: 'oversize', size: buf.length },
      };
    }
    const maxRenderPages = Math.min(
      MAX_RENDER_PAGES,
      Math.max(0, Math.floor(args.max_pages ?? DEFAULT_MAX_RENDER_PAGES)),
    );

    // Text-only models can't read image blocks — OCR image content to text instead.
    const textOnly = context.modelSupportsImageInput === false;
    let worker: Worker | null = null;
    let ocrUnavailable = false;
    let ocrUsed = false;
    const ocr = textOnly
      ? async (png: Buffer): Promise<string | null> => {
          if (ocrUnavailable) return null;
          try {
            worker ??= await createOcrWorker();
          } catch {
            ocrUnavailable = true;
            return null;
          }
          ocrUsed = true;
          return ocrPng(worker, png);
        }
      : null;

    try {
      const format = detectFormat(buf, name);
      if (format === 'pdf') {
        const canvasImport = await loadCanvasImport();
        const blocks = await readPdf(buf, maxRenderPages, ocr, canvasImport);
        if (ocrUsed) blocks.push({ type: 'text', text: OCR_NOTE });
        return { content: blocks, details: { id: row.id, kind: 'pdf' } };
      }
      // csv is already plain text; a markdown table would only pad it out. Handled
      // here rather than left to isTextMime so a mislabelled .csv still reads.
      if (format === 'csv') {
        return {
          content: asTextContent(buf.toString('utf8')),
          details: { id: row.id, kind: 'csv', size: buf.length },
        };
      }
      if (format) {
        const blocks = await readOfficeDoc(buf, format as Format, maxRenderPages, ocr);
        if (ocrUsed) blocks.push({ type: 'text', text: OCR_NOTE });
        return { content: blocks, details: { id: row.id, kind: format } };
      }
      if (isNotebook(mime, name)) {
        const text = readNotebook(buf);
        return {
          content: asTextContent(text || '(notebook has no readable cells)'),
          details: { id: row.id, kind: 'ipynb' },
        };
      }
      if (isImageMime(mime)) {
        if (ocr) {
          const text = await ocr(buf);
          if (text === null) {
            return {
              content: asTextContent(
                formatJson({ ...summary, note: `image OCR is unavailable in this build (the tesseract.js backend isn't installed). Use a multimodal model, or the sandbox_path with Read/Bash.` }),
              ),
              details: { id: row.id, kind: 'image-ocr-unavailable', mimeType: mime },
            };
          }
          return {
            content: asTextContent(`${text || `(no text found in image ${name})`}\n\n${OCR_NOTE}`),
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
      // anydoc rejects with a ConvertErrorCode on `code` (encrypted, malformed,
      // unsupported, …), which says more than the message alone.
      const msg = err instanceof Error ? err.message : String(err);
      const code = (err as { code?: unknown })?.code;
      return {
        content: asTextContent(
          formatJson({
            ...summary,
            error: `failed to extract${typeof code === 'string' ? ` (${code})` : ''}: ${msg}. Try the sandbox_path with Read/Bash.`,
          }),
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

\`doc_read\` extracts the contents of an uploaded document into the model context as Markdown: PDF, Word (.doc/.docx), Excel (.xls/.xlsx), PowerPoint (.ppt/.pptx), OpenDocument (.odt/.ods/.odp), RTF and EPUB, plus Jupyter notebooks (.ipynb) as cell sources and images directly. Images embedded in a document, and scanned/image-only PDF pages, come through as images for a multimodal model to read. Pass an \`attachment_id\` from \`attachment_list\`. For plain text/code or other formats, use \`attachment_fetch\`.`;

export const createDocToolset = (context: ToolContext): Toolset => ({
  id: 'doc',
  description: DOC_TOOLSET_DESCRIPTION,
  tools: [createDocReadTool(context)],
});
