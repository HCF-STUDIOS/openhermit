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

/**
 * A failed/aborted assistant turn that carries no usable content. When a
 * provider stream throws mid-turn (e.g. credit depletion, a transient 5xx),
 * pi-agent-core records the failure as an assistant message with empty content
 * and `stopReason: 'error' | 'aborted'` (see its `handleRunFailure`). That
 * placeholder is never a valid thing to send back to a provider — an empty
 * content block makes Anthropic (and most providers) reject the *next* request
 * with a 400, so a session that hit a failure keeps failing even after the
 * underlying cause is resolved. Detect those so we can drop them.
 *
 * The check is deliberately narrow: only assistant turns with no meaningful
 * content (no non-empty text, no tool call, no thinking) qualify, so we never
 * orphan tool results or discard a partial reply that actually said something.
 */
export const isEmptyAssistantTurn = (message: AgentMessage): boolean => {
  if (!isAssistantMessage(message)) return false;
  const content = Array.isArray(message.content) ? message.content : [];
  const hasUsableContent = content.some((block) => {
    if (!block || typeof block !== 'object' || !('type' in block)) return false;
    if (block.type === 'text') {
      return typeof (block as TextContent).text === 'string'
        && (block as TextContent).text.trim().length > 0;
    }
    // Any non-text block (toolCall, thinking, etc.) counts as usable content.
    return true;
  });
  return !hasUsableContent;
};

/**
 * Remove failed/aborted placeholder assistant turns (see `isEmptyAssistantTurn`)
 * from a message history. Used both to clean the live in-memory transcript after
 * a run failure and as a defensive guard right before LLM conversion.
 */
export const stripEmptyAssistantTurns = (messages: AgentMessage[]): AgentMessage[] =>
  messages.filter((message) => !isEmptyAssistantTurn(message));

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

// The (?!\() excludes markdown links `[x](y)`; the length cap keeps it to a name.
const LEADING_SPEAKER_TAG = /^\s*\[([^[\]\n]{1,80})\](?!\()\s*:?\s*/;

// Strip a leading `[Name]` tag the model copied from the group input format
// (`[DisplayName] text`), only when the name is a known participant. Unknown
// tags and markdown links are left alone.
export const stripLeadingSpeakerTag = (
  text: string,
  knownNames: Iterable<string>,
): string => {
  const match = LEADING_SPEAKER_TAG.exec(text);
  if (!match) return text;

  const known = toKnownSet(knownNames);
  if (known.size === 0) return text;

  const candidate = normalizeSpeakerName(match[1]!);
  if (!known.has(candidate)) return text;

  // An empty assistant turn corrupts the stored history, so keep the original.
  const stripped = text.slice(match[0].length);
  return stripped.trim().length > 0 ? stripped : text;
};

// So a name matches regardless of unicode composition or case.
export const normalizeSpeakerName = (name: string): string =>
  name.trim().normalize('NFC').toLowerCase();

const toKnownSet = (knownNames: Iterable<string>): Set<string> => {
  const known = new Set<string>();
  for (const name of knownNames) {
    const norm = normalizeSpeakerName(name);
    if (norm) known.add(norm);
  }
  return known;
};

// Past this many chars, a leading tag is no longer plausible; stop buffering.
const MAX_LEAD_BUFFER = 96;

// Without this, a live token stream would flicker `[Name]` before the final
// strip lands. Buffers the start of a text block until the tag resolves.
export interface SpeakerTagStreamState {
  buffer: string;
  resolved: boolean;
}

export const newSpeakerTagStream = (): SpeakerTagStreamState => ({
  buffer: '',
  resolved: false,
});

const decideLead = (
  buffer: string,
  knownNames: Iterable<string>,
): { resolved: false } | { resolved: true; emit: string } => {
  const afterWs = buffer.replace(/^\s+/, '');
  if (afterWs.length === 0) return { resolved: false };
  if (afterWs[0] !== '[') return { resolved: true, emit: buffer };

  const match = LEADING_SPEAKER_TAG.exec(buffer);
  if (match) {
    const rest = buffer.slice(match[0].length);
    if (rest.trim().length > 0) {
      return { resolved: true, emit: stripLeadingSpeakerTag(buffer, knownNames) };
    }
    // Tag closed but no content yet, so wait for more if it's a known sender.
    const candidate = normalizeSpeakerName(match[1]!);
    if (!toKnownSet(knownNames).has(candidate)) {
      return { resolved: true, emit: buffer };
    }
    return { resolved: false };
  }

  // Open '[' that can no longer become a single-line tag.
  if (afterWs.includes('\n') || buffer.length > MAX_LEAD_BUFFER) {
    return { resolved: true, emit: buffer };
  }
  return { resolved: false };
};

// Returns '' while still buffering the lead, otherwise the text to emit.
export const pushSpeakerTagDelta = (
  state: SpeakerTagStreamState,
  delta: string,
  knownNames: Iterable<string>,
): string => {
  if (state.resolved) return delta;
  state.buffer += delta;
  const decision = decideLead(state.buffer, knownNames);
  if (!decision.resolved) return '';
  state.resolved = true;
  return decision.emit;
};

// Idempotent: returns '' once the block has already resolved.
export const flushSpeakerTagStream = (
  state: SpeakerTagStreamState,
  knownNames: Iterable<string>,
): string => {
  if (state.resolved) return '';
  state.resolved = true;
  return stripLeadingSpeakerTag(state.buffer, knownNames);
};

export interface GroupParticipant {
  id: string;
  type: string;
  displayName: string;
  handle?: string;
}

export interface MentionRef {
  id: string;
  type: string;
}

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const mentionToken = (name: string): string =>
  name.trim().normalize('NFC').toLowerCase();

const PROTECTED_SPAN = /```[\s\S]*?(?:```|$)|``[^`]*``|`[^`]*`|(?<!@)\[[^\]\n]*\]\([^)\n]*\)/g;
const MENTION_MARKUP = /@\[[^\]\n]+\]\(([^():\n]+):([^()\n]+)\)/g;

const mapOutsideProtected = (text: string, fn: (segment: string) => string): string => {
  let out = '';
  let last = 0;
  for (const span of text.matchAll(PROTECTED_SPAN)) {
    out += fn(text.slice(last, span.index));
    out += span[0];
    last = span.index! + span[0].length;
  }
  out += fn(text.slice(last));
  return out;
};

const MAX_MENTION_PARTICIPANTS = 256;
const MAX_MENTION_TOKEN_CHARS = 128;

export const transcodeGroupMentions = (
  text: string,
  participants: Iterable<GroupParticipant>,
): string => {
  const byToken = new Map<string, GroupParticipant | null>();
  const addToken = (raw: string | undefined, participant: GroupParticipant) => {
    const key = raw ? mentionToken(raw) : '';
    if (!key || key.length > MAX_MENTION_TOKEN_CHARS) return;
    const existing = byToken.get(key);
    if (existing === undefined) byToken.set(key, participant);
    else if (existing && existing.id !== participant.id) byToken.set(key, null);
  };
  let participantCount = 0;
  for (const participant of participants) {
    if (++participantCount > MAX_MENTION_PARTICIPANTS) return text;
    addToken(participant.displayName, participant);
    addToken(participant.handle, participant);
  }
  // Longest first so multi-word names win over their own prefixes.
  const tokens = [...byToken.keys()].sort((a, b) => b.length - a.length);
  if (tokens.length === 0) return text;

  const alternation = tokens.map(escapeRegExp).join('|');
  const re = new RegExp(
    `(?<![\\p{L}\\p{N}_@/])@(?:\\[(${alternation})\\]|(${alternation})(?![\\p{L}\\p{N}_/-]))(?!\\()`,
    'giu',
  );

  const rewrite = (segment: string): string =>
    segment.replace(re, (match, bracketed, bare) => {
      const participant = byToken.get(mentionToken((bracketed ?? bare) as string));
      if (!participant) return match;
      if (/[[\]()]/.test(participant.displayName)) return match;
      return `@[${participant.displayName}](${participant.id}:${participant.type})`;
    });

  return mapOutsideProtected(text, (segment) => rewrite(segment.normalize('NFC')));
};

// Resolve the mentions present in a rendered reply by reading the markup
export const extractMentionRefs = (
  text: string,
  participants: Iterable<GroupParticipant>,
): MentionRef[] => {
  const typeById = new Map<string, string>();
  for (const participant of participants) typeById.set(participant.id, participant.type);
  if (typeById.size === 0) return [];

  const seen = new Set<string>();
  const mentions: MentionRef[] = [];
  mapOutsideProtected(text, (segment) => {
    for (const match of segment.matchAll(MENTION_MARKUP)) {
      const id = match[1]!;
      const type = typeById.get(id);
      if (type !== undefined && !seen.has(id)) {
        seen.add(id);
        mentions.push({ id, type });
      }
    }
    return segment;
  });
  return mentions;
};

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
