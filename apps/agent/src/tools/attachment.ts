import { Type, type Static } from '@mariozechner/pi-ai';
import { ValidationError } from '@openhermit/shared';

import {
  type PolicyAwareTool,
  type Toolset,
  type ToolContext,
  asTextContent,
  formatJson,
} from './shared.js';

const AttachmentListParams = Type.Object({
  scope: Type.Optional(
    Type.Union([Type.Literal('session'), Type.Literal('user')], {
      description:
        "Visibility scope. 'session' (default) lists attachments uploaded in the current session. 'user' lists attachments the current user has uploaded across all of their sessions on this agent.",
    }),
  ),
  limit: Type.Optional(
    Type.Number({ description: 'Maximum number of attachments to return (default 20).' }),
  ),
});

type AttachmentListArgs = Static<typeof AttachmentListParams>;

const AttachmentFetchParams = Type.Object({
  attachment_id: Type.String({
    description: 'The id returned by `attachment_list` (e.g. `att_xxx`).',
  }),
  mode: Type.Optional(
    Type.Union(
      [Type.Literal('auto'), Type.Literal('text'), Type.Literal('image'), Type.Literal('metadata')],
      {
        description:
          "How to return the attachment. 'auto' (default) returns inline text for text/*, an image block for image/*, and metadata otherwise. 'text' forces UTF-8 decode (rejects non-text). 'image' forces an image block (rejects non-image). 'metadata' returns the row + size + sha256 only.",
      },
    ),
  ),
  max_bytes: Type.Optional(
    Type.Number({
      description:
        'Cap the bytes read into the model context. Default 512 KiB. Files larger than the cap return metadata + sandbox_path so the agent can use Read/Bash on disk instead.',
    }),
  ),
});

type AttachmentFetchArgs = Static<typeof AttachmentFetchParams>;

const DEFAULT_FETCH_MAX_BYTES = 512 * 1024;

const isTextMime = (mime: string): boolean =>
  mime.startsWith('text/') ||
  mime === 'application/json' ||
  mime === 'application/xml' ||
  mime === 'application/x-yaml' ||
  mime === 'application/yaml' ||
  mime === 'application/javascript' ||
  /\+(?:json|xml|yaml)$/.test(mime);

const isImageMime = (mime: string): boolean => mime.startsWith('image/');

const recordSummary = (
  r: import('@openhermit/store').AttachmentRecord,
): Record<string, unknown> => ({
  id: r.id,
  sessionId: r.sessionId,
  uploaderUserId: r.uploaderUserId,
  name: r.originalName,
  mimeType: r.mimeType,
  size: r.sizeBytes,
  sha256: r.sha256,
  sandboxPath: r.sandboxPath,
  sandboxId: r.sandboxId,
  materializationState: r.materializationState,
  createdAt: r.createdAt,
});

async function streamToBuffer(stream: NodeJS.ReadableStream, cap: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let seen = 0;
  for await (const chunk of stream) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer);
    seen += buf.length;
    chunks.push(buf);
    if (seen >= cap) {
      // Stop early — caller will treat the read as oversized.
      return Buffer.concat(chunks).subarray(0, cap);
    }
  }
  return Buffer.concat(chunks);
}

export const createAttachmentListTool = (
  context: ToolContext,
): PolicyAwareTool<typeof AttachmentListParams> => ({
  policy: { defaultGrants: [{ type: 'any' }] },
  name: 'attachment_list',
  label: 'List Attachments',
  description:
    'List files the user has uploaded into this session (default) or across the user\'s sessions on this agent (scope=user). Returns id, name, mime, size, and sandbox path.',
  parameters: AttachmentListParams,
  execute: async (_toolCallId, args: AttachmentListArgs) => {
    if (!context.attachmentStore || !context.storeScope || !context.sessionId) {
      throw new ValidationError(
        'attachment_list is unavailable: attachment storage is not configured.',
      );
    }
    const scope = args.scope ?? 'session';
    const limit = args.limit ?? 20;
    const opts: import('@openhermit/store').AttachmentListOptions = {
      scope,
      ...(limit ? { limit } : {}),
      ...(scope === 'user' && context.currentUserId
        ? { userId: context.currentUserId }
        : {}),
    };
    if (scope === 'user' && !context.currentUserId) {
      throw new ValidationError(
        'attachment_list scope=user requires a resolved user — only authenticated users may list across sessions.',
      );
    }
    const rows = await context.attachmentStore.list(
      context.storeScope,
      context.sessionId,
      opts,
    );
    const result = rows.map(recordSummary);
    return {
      content: asTextContent(
        result.length > 0 ? formatJson(result) : 'No attachments found.\n',
      ),
      details: { count: result.length, scope },
    };
  },
});

export const createAttachmentFetchTool = (
  context: ToolContext,
): PolicyAwareTool<typeof AttachmentFetchParams> => ({
  policy: { defaultGrants: [{ type: 'any' }] },
  name: 'attachment_fetch',
  label: 'Fetch Attachment',
  description:
    'Read an uploaded file into the model context. Use mode=auto to let the tool pick a representation: text/* and JSON come back as inline text; image/* comes back as an image block; everything else returns metadata + the sandbox path so you can Read or run a command on it.',
  parameters: AttachmentFetchParams,
  execute: async (_toolCallId, args: AttachmentFetchArgs) => {
    if (!context.attachmentStore || !context.attachmentStorage || !context.storeScope) {
      throw new ValidationError(
        'attachment_fetch is unavailable: attachment storage is not configured.',
      );
    }
    const id = args.attachment_id.trim();
    if (!id) {
      throw new ValidationError('attachment_fetch requires a non-empty attachment_id.');
    }
    const row = await context.attachmentStore.get(id);
    if (!row || row.agentId !== context.storeScope.agentId) {
      throw new ValidationError(`attachment_fetch: no such attachment ${id}.`);
    }
    // Visibility: same session is always allowed; cross-session is allowed
    // only when the caller is the uploader (or the owner).
    const sameSession = row.sessionId === context.sessionId;
    const isOwner = context.currentUserRole === 'owner';
    const isUploader = !!row.uploaderUserId && row.uploaderUserId === context.currentUserId;
    if (!sameSession && !isOwner && !isUploader) {
      throw new ValidationError(
        `attachment_fetch: attachment ${id} is not visible in this session.`,
      );
    }

    const mode = args.mode ?? 'auto';
    const cap = Math.max(1, args.max_bytes ?? DEFAULT_FETCH_MAX_BYTES);

    if (mode === 'metadata') {
      return {
        content: asTextContent(formatJson(recordSummary(row))),
        details: { id: row.id, mode: 'metadata' },
      };
    }

    // Decide a representation.
    const wantsImage = mode === 'image' || (mode === 'auto' && isImageMime(row.mimeType));
    const wantsText = mode === 'text' || (mode === 'auto' && isTextMime(row.mimeType));

    if (mode === 'text' && !isTextMime(row.mimeType)) {
      throw new ValidationError(
        `attachment_fetch mode=text requires a text mimetype; got ${row.mimeType}. Use mode=auto or mode=metadata.`,
      );
    }
    if (mode === 'image' && !isImageMime(row.mimeType)) {
      throw new ValidationError(
        `attachment_fetch mode=image requires an image mimetype; got ${row.mimeType}. Use mode=auto or mode=metadata.`,
      );
    }

    // Files larger than the cap aren't pulled into model context.
    if (row.sizeBytes > cap && !wantsImage) {
      return {
        content: asTextContent(
          formatJson({
            ...recordSummary(row),
            note: `file is ${row.sizeBytes} bytes which exceeds max_bytes=${cap}. Use the sandbox_path with the Read or Bash tools to access it.`,
          }),
        ),
        details: { id: row.id, mode: 'metadata-oversize', cap, size: row.sizeBytes },
      };
    }

    // For images we still respect the cap as a safety net, but most
    // production thresholds (a few MB) are below typical model image
    // limits.
    const stream = await context.attachmentStorage.readStream(row.storageKey);
    const buf = await streamToBuffer(stream, Math.max(cap, row.sizeBytes));

    if (wantsImage) {
      return {
        content: [
          {
            type: 'image' as const,
            data: buf.toString('base64'),
            mimeType: row.mimeType,
          },
          { type: 'text' as const, text: `(image attachment: ${row.originalName})` },
        ],
        details: { id: row.id, mode: 'image', mimeType: row.mimeType, size: buf.length },
      };
    }

    if (wantsText) {
      return {
        content: asTextContent(buf.toString('utf8')),
        details: { id: row.id, mode: 'text', size: buf.length },
      };
    }

    // Binary fallthrough — return metadata + sandbox pointer.
    return {
      content: asTextContent(
        formatJson({
          ...recordSummary(row),
          note: `mime ${row.mimeType} is neither text nor image; use the sandbox_path with the Read tool (binary) or run a converter via Bash.`,
        }),
      ),
      details: { id: row.id, mode: 'metadata-binary', size: row.sizeBytes },
    };
  },
});

const ATTACHMENT_DESCRIPTION = `\
### Attachments

The user can upload files (images, PDFs, text, code). Each upload becomes an attachment with a stable id and a mirror copy inside the sandbox at \`~/.openhermit/attachments/<sessionId>/<id>/<name>\` when small enough.

- \`attachment_list\` — see what files exist (scope=session by default).
- \`attachment_fetch\` — pull a file into the model context. Use mode=auto for image/* and text/*; for large or binary files prefer the sandbox path with Read/Bash.`;

export const createAttachmentToolset = (context: ToolContext): Toolset => ({
  id: 'attachment',
  description: ATTACHMENT_DESCRIPTION,
  tools: [createAttachmentListTool(context), createAttachmentFetchTool(context)],
});
