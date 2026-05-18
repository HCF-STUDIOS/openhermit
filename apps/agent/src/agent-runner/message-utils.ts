import type { AgentMessage } from '@mariozechner/pi-agent-core';
import type { AssistantMessage, ImageContent, Message, TextContent } from '@mariozechner/pi-ai';

import type { SessionAttachment, SessionMessage } from '@openhermit/protocol';
import type { AttachmentStorage, AttachmentStore } from '@openhermit/store';

export const isAssistantMessage = (
  message: AgentMessage,
): message is AssistantMessage =>
  typeof message === 'object' &&
  message !== null &&
  'role' in message &&
  message.role === 'assistant';

export const extractAssistantText = (message: AssistantMessage): string => {
  const textParts = message.content
    .filter((content): content is Extract<typeof content, { type: 'text' }> => content.type === 'text')
    .map((content) => content.text.trim())
    .filter((text) => text.length > 0);

  return textParts.join('\n\n');
};

export const extractThinkingText = (message: AssistantMessage): string => {
  const parts = message.content
    .filter((content): content is Extract<typeof content, { type: 'thinking' }> =>
      content.type === 'thinking' && 'thinking' in content && typeof (content as any).thinking === 'string')
    .map((content) => (content as any).thinking.trim())
    .filter((text: string) => text.length > 0);

  return parts.join('\n\n');
};

// Some OpenAI-compatible providers (e.g. DeepSeek with reasoning_content,
// llama.cpp, gpt-oss) require the prior reasoning to be passed back on the
// exact provider-specific field. The pi-ai provider records that field name
// on the thinking block as `thinkingSignature` so it can echo it correctly.
// We need to persist it so resumed sessions don't lose it.
export const extractThinkingSignature = (message: AssistantMessage): string | undefined => {
  for (const block of message.content) {
    if (block.type !== 'thinking') continue;
    const sig = (block as { thinkingSignature?: unknown }).thinkingSignature;
    if (typeof sig === 'string' && sig.length > 0) return sig;
  }
  return undefined;
};

export const hasMeaningfulAssistantText = (text: string): boolean =>
  text.trim().length > 0;

export const createUserMessage = (
  message: SessionMessage,
  attachmentContent: (TextContent | ImageContent)[] = [],
): Message => {
  const blocks: (TextContent | ImageContent)[] = [];
  if (message.text && message.text.length > 0) {
    blocks.push({ type: 'text', text: message.text });
  }
  for (const block of attachmentContent) {
    blocks.push(block);
  }
  // pi-ai allows an empty array but the model providers reject it. If
  // nothing came in (no text + no attachments), fall back to a single
  // empty string text block so the request still typechecks.
  if (blocks.length === 0) {
    blocks.push({ type: 'text', text: '' });
  }
  return {
    role: 'user',
    content: blocks,
    timestamp: Date.now(),
  };
};

/**
 * Image MIME types pi-ai providers will accept inline. PNG/JPEG/GIF/WebP
 * are universally supported; HEIC and AVIF land outside the safe set.
 */
const INLINE_IMAGE_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp',
]);

export interface PrepareAttachmentContentOptions {
  /** Hard cap on bytes embedded per attachment. Default 1 MiB. */
  maxInlineBytes?: number;
  /** Max number of image attachments to embed inline. Default 4. */
  maxImageInline?: number;
  /**
   * Whether the active model accepts image input. When false, image
   * attachments are downgraded to text references (the model can't see
   * them but knows they exist). Defaults to true for backwards-compat;
   * the runner passes the actual capability from pi-ai's model registry.
   */
  supportsImageInput?: boolean;
  /** Logger for soft failures (storage read errors, oversized files). */
  log?: (msg: string) => void;
}

const DEFAULT_INLINE_BYTES = 1024 * 1024;
const DEFAULT_MAX_IMAGE_INLINE = 4;

/**
 * Resolve `SessionAttachment[]` into model-ready content blocks. Small
 * supported images are embedded as `ImageContent` (multimodal fast path).
 * Everything else becomes a structured text reference pointing at the
 * sandbox path, so the agent can call `attachment_fetch` or use Read /
 * Bash without us having to inline the bytes.
 *
 * Soft failures (storage outage, oversized file) downgrade to a text
 * reference rather than throwing — the user can still see what they
 * uploaded even if we can't embed it.
 */
export const prepareAttachmentContent = async (
  attachments: SessionAttachment[] | undefined,
  stores: {
    attachmentStore?: AttachmentStore | undefined;
    attachmentStorage?: AttachmentStorage | undefined;
  },
  options: PrepareAttachmentContentOptions = {},
): Promise<(TextContent | ImageContent)[]> => {
  if (!attachments || attachments.length === 0) return [];
  const maxBytes = options.maxInlineBytes ?? DEFAULT_INLINE_BYTES;
  const maxImageInline = options.maxImageInline ?? DEFAULT_MAX_IMAGE_INLINE;
  const supportsImageInput = options.supportsImageInput ?? true;
  const out: (TextContent | ImageContent)[] = [];
  let imagesInlined = 0;

  for (const att of attachments) {
    const id = att.id;
    const name = att.name ?? '(unnamed)';
    const mime = att.mimeType ?? 'application/octet-stream';
    const size = att.size ?? 0;
    const path = att.sandboxPath ?? null;
    const isImage = INLINE_IMAGE_MIMES.has(mime.toLowerCase());

    const canInlineImage =
      supportsImageInput &&
      stores.attachmentStore &&
      stores.attachmentStorage &&
      id &&
      isImage &&
      size > 0 &&
      size <= maxBytes &&
      imagesInlined < maxImageInline;

    if (canInlineImage) {
      try {
        const row = await stores.attachmentStore!.get(id);
        if (row) {
          const stream = await stores.attachmentStorage!.readStream(row.storageKey);
          const buf = await streamToBoundedBuffer(stream, maxBytes);
          if (buf.length > 0) {
            out.push({
              type: 'image',
              data: buf.toString('base64'),
              mimeType: mime,
            });
            imagesInlined += 1;
            continue;
          }
        }
      } catch (err) {
        options.log?.(
          `[attachments] inline image read failed for ${id}: ${
            err instanceof Error ? err.message : String(err)
          } — falling back to reference`,
        );
      }
    }

    const ref = formatAttachmentReference({
      ...(id ? { id } : {}),
      name,
      mime,
      size,
      path,
      imageDowngraded: isImage && !supportsImageInput,
    });
    out.push({ type: 'text', text: ref });
  }
  return out;
};

const formatAttachmentReference = (info: {
  id?: string;
  name: string;
  mime: string;
  size: number;
  path: string | null;
  imageDowngraded?: boolean;
}): string => {
  const lines: string[] = [];
  lines.push('[attachment]');
  if (info.id) lines.push(`id: ${info.id}`);
  lines.push(`name: ${info.name}`);
  lines.push(`mime: ${info.mime}`);
  if (info.size > 0) lines.push(`size: ${info.size} bytes`);
  if (info.path) {
    lines.push(`sandbox_path: ${info.path}`);
    lines.push('(use the Read tool on the sandbox_path, or call attachment_fetch with this id.)');
  } else {
    lines.push('(no sandbox copy available — call attachment_fetch with this id to load it.)');
  }
  if (info.imageDowngraded) {
    lines.push(
      '(note: this is an image, but the active model is text-only and cannot view it directly. ' +
        'Acknowledge the upload to the user and, if needed, ask them to switch to a multimodal model.)',
    );
  }
  return lines.join('\n');
};

async function streamToBoundedBuffer(
  stream: NodeJS.ReadableStream,
  maxBytes: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let seen = 0;
  for await (const chunk of stream) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer);
    seen += buf.length;
    chunks.push(buf);
    if (seen >= maxBytes) {
      return Buffer.concat(chunks).subarray(0, maxBytes);
    }
  }
  return Buffer.concat(chunks);
}

export const serializeDetails = (value: unknown): string =>
  `${JSON.stringify(value, null, 2)}\n`;

export const extractToolResultText = (result: unknown): string | undefined => {
  if (!result || typeof result !== 'object') {
    return undefined;
  }

  const content = 'content' in result ? result.content : undefined;

  if (!Array.isArray(content)) {
    return undefined;
  }

  const textParts = content
    .filter(
      (entry): entry is { type: 'text'; text: string } =>
        typeof entry === 'object' &&
        entry !== null &&
        'type' in entry &&
        entry.type === 'text' &&
        'text' in entry &&
        typeof entry.text === 'string',
    )
    .map((entry) => entry.text.trim())
    .filter((entry) => entry.length > 0);

  if (textParts.length === 0) {
    return undefined;
  }

  return textParts.join('\n');
};

export const extractToolResultDetails = (result: unknown): unknown => {
  if (!result || typeof result !== 'object') {
    return undefined;
  }

  if (!('details' in result)) {
    return undefined;
  }

  return result.details;
};
