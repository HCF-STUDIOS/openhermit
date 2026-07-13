/**
 * Pure parsing helpers for inbound Lark/Feishu `im.message.receive_v1`
 * events. Kept side-effect-free so they can be unit-tested without the
 * SDK or a live connection.
 */

/** One entry of the event's `mentions` array. */
export interface LarkMention {
  /** Placeholder key as it appears in the text content, e.g. `@_user_1`. */
  key: string;
  id?: { open_id?: string; union_id?: string; user_id?: string };
  name?: string;
}

/** Normalized inbound content: text plus optional media reference. */
export interface ParsedContent {
  text: string;
  /** Set for `image` messages. */
  imageKey?: string;
  /** Set for `file` / `media` / `audio` messages. */
  fileKey?: string;
  fileName?: string;
  /** True when the message type carries nothing we can forward. */
  unsupported?: boolean;
}

/**
 * Parse the JSON-string `content` of an inbound message by `message_type`.
 * Lark double-encodes: `content` is itself a JSON document.
 */
export const parseMessageContent = (messageType: string, content: string): ParsedContent => {
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(content) as Record<string, unknown>;
  } catch {
    return { text: '', unsupported: true };
  }

  switch (messageType) {
    case 'text':
      return { text: typeof body.text === 'string' ? body.text : '' };

    case 'post': {
      // Rich text: { title?, content: [[{tag, text|href|user_id, ...}, ...], ...] }
      const lines: string[] = [];
      const title = typeof body.title === 'string' ? body.title.trim() : '';
      if (title) lines.push(title);
      const rows = Array.isArray(body.content) ? body.content : [];
      for (const row of rows) {
        if (!Array.isArray(row)) continue;
        const parts: string[] = [];
        for (const node of row) {
          if (!node || typeof node !== 'object') continue;
          const n = node as Record<string, unknown>;
          // Order matters: `a` and `at` nodes also carry a `text` field.
          if (n.tag === 'a' && typeof n.href === 'string') parts.push(String(n.href));
          else if (n.tag === 'at') parts.push(typeof n.user_name === 'string' ? `@${n.user_name}` : '');
          else if (typeof n.text === 'string') parts.push(n.text);
        }
        const line = parts.join('');
        if (line.trim()) lines.push(line);
      }
      return { text: lines.join('\n') };
    }

    case 'image':
      return {
        text: '',
        ...(typeof body.image_key === 'string' ? { imageKey: body.image_key } : {}),
      };

    case 'file':
    case 'media':
    case 'audio':
      return {
        text: '',
        ...(typeof body.file_key === 'string' ? { fileKey: body.file_key } : {}),
        ...(typeof body.file_name === 'string' ? { fileName: body.file_name } : {}),
      };

    default:
      // sticker, share_chat, interactive, …
      return { text: '', unsupported: true };
  }
};

/**
 * Whether the bot is addressed. DMs always count; group messages count only
 * when the bot itself appears in `mentions` (requires the
 * `im:message.group_at_msg` event permission — without it Lark never
 * delivers group messages at all).
 */
export const isBotMentioned = (
  chatType: string,
  mentions: LarkMention[] | undefined,
  botOpenId: string | undefined,
): boolean => {
  if (chatType !== 'group') return true;
  if (!botOpenId || !Array.isArray(mentions)) return false;
  return mentions.some((m) => m.id?.open_id === botOpenId);
};

/**
 * Replace mention placeholders (`@_user_1` …) in the text: the bot's own
 * mention is stripped; other users' become `@Name` so the agent still sees
 * who was addressed.
 */
export const stripMentionPlaceholders = (
  text: string,
  mentions: LarkMention[] | undefined,
  botOpenId: string | undefined,
): string => {
  if (!Array.isArray(mentions) || mentions.length === 0) return text.trim();
  let out = text;
  for (const m of mentions) {
    if (!m.key) continue;
    const replacement = m.id?.open_id === botOpenId ? '' : `@${m.name ?? 'user'}`;
    out = out.split(m.key).join(replacement);
  }
  return out.replace(/\s{2,}/g, ' ').trim();
};

/** Lark text messages cap out well above this; chunk conservatively. */
export const TEXT_CHUNK_CHARS = 4000;

/** Split a long reply into send-sized chunks, preferring newline boundaries. */
export const chunkText = (text: string, max = TEXT_CHUNK_CHARS): string[] => {
  const t = text.trim();
  if (t.length <= max) return t ? [t] : [];
  const chunks: string[] = [];
  let rest = t;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < max * 0.5) cut = max;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
};
