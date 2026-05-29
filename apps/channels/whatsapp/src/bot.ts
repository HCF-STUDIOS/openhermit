import type { WhatsAppBridge, WhatsAppIncomingMedia, WhatsAppIncomingMessage } from './bridge.js';
import { cleanBotCommandText, isBroadcastJid, isGroupJid, jidToPhone, normalizeJid } from './jid.js';
import type { RawWhatsAppMessage, WhatsAppApi } from './whatsapp-api.js';

/** Gateway-enforced attachment cap (25 MiB). Skip oversized media early. */
const MAX_MEDIA_BYTES = 25 * 1024 * 1024;

export interface WhatsAppBotOptions {
  whatsapp: WhatsAppApi;
  bridge: WhatsAppBridge;
  logger?: (message: string) => void;
}

export class WhatsAppBot {
  private readonly log: (message: string) => void;

  constructor(private readonly options: WhatsAppBotOptions) {
    this.log = options.logger ?? ((msg) => console.log(`[whatsapp-bot] ${msg}`));
  }

  async start(): Promise<void> {
    this.options.whatsapp.onMessage((message) => {
      void this.handleRawMessage(message);
    });
    await this.options.whatsapp.start();
  }

  async stop(): Promise<void> {
    await this.options.whatsapp.stop();
  }

  private async handleRawMessage(message: RawWhatsAppMessage): Promise<void> {
    try {
      const event = toIncomingMessage(message, this.options.whatsapp.botJid);
      if (!event) return;
      // Download media bytes here (transport layer); the bridge handles the
      // agent-side upload / transcription.
      if (event.media) {
        try {
          const bytes = await this.options.whatsapp.downloadMedia(message);
          if (bytes.length > MAX_MEDIA_BYTES) {
            this.log(`dropping oversized media (${bytes.length} bytes) from ${event.chatJid}`);
            delete event.media;
          } else {
            event.media.bytes = bytes;
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.log(`media download failed for ${event.chatJid}: ${msg}`);
          delete event.media;
        }
        // Media-only message whose download failed: nothing to forward.
        if (!event.media && !event.text) return;
      }
      await this.options.bridge.handleIncoming(event);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log(`error handling message: ${msg}`);
    }
  }
}

/** Map a MIME type to a coarse attachment kind for routing. */
function mediaKindFromMime(mime: string): WhatsAppIncomingMedia['kind'] {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'document';
}

/** Best-effort filename for media that lacks one, derived from the MIME type. */
function synthFilename(kind: WhatsAppIncomingMedia['kind'], mime: string): string {
  const ext = mime.split(';')[0]?.split('/')[1]?.replace(/[^a-z0-9]+/gi, '') || 'bin';
  return `${kind}.${ext}`;
}

/**
 * Detect an inbound media node (image/video/document/audio) and return its
 * metadata. Bytes are downloaded later by the bot. Returns undefined for
 * text-only messages.
 */
export function extractMedia(message: RawWhatsAppMessage): WhatsAppIncomingMedia | undefined {
  const content = unwrapMessageContent(message.message);
  if (!content || typeof content !== 'object') return undefined;

  const image = content.imageMessage;
  if (image) {
    const mime = typeof image.mimetype === 'string' ? image.mimetype : 'image/jpeg';
    return { kind: 'image', mimeType: mime, filename: synthFilename('image', mime), isVoice: false };
  }
  const video = content.videoMessage;
  if (video) {
    const mime = typeof video.mimetype === 'string' ? video.mimetype : 'video/mp4';
    return { kind: 'video', mimeType: mime, filename: synthFilename('video', mime), isVoice: false };
  }
  const audio = content.audioMessage;
  if (audio) {
    const mime = typeof audio.mimetype === 'string' ? audio.mimetype : 'audio/ogg';
    return {
      kind: 'audio',
      mimeType: mime,
      filename: synthFilename('audio', mime),
      isVoice: audio.ptt === true,
    };
  }
  const doc = content.documentMessage;
  if (doc) {
    const mime = typeof doc.mimetype === 'string' ? doc.mimetype : 'application/octet-stream';
    const filename =
      typeof doc.fileName === 'string' && doc.fileName.trim()
        ? doc.fileName.trim()
        : synthFilename('document', mime);
    return { kind: mediaKindFromMime(mime), mimeType: mime, filename, isVoice: false };
  }
  return undefined;
}

function unwrapMessageContent(content: any): any {
  let current = content;
  for (let i = 0; i < 4; i += 1) {
    if (!current || typeof current !== 'object') return current;
    if (current.ephemeralMessage?.message) {
      current = current.ephemeralMessage.message;
      continue;
    }
    if (current.viewOnceMessage?.message) {
      current = current.viewOnceMessage.message;
      continue;
    }
    if (current.viewOnceMessageV2?.message) {
      current = current.viewOnceMessageV2.message;
      continue;
    }
    if (current.documentWithCaptionMessage?.message) {
      current = current.documentWithCaptionMessage.message;
      continue;
    }
    return current;
  }
  return current;
}

export function extractText(message: RawWhatsAppMessage): string | undefined {
  const content = unwrapMessageContent(message.message);
  const candidates = [
    content?.conversation,
    content?.extendedTextMessage?.text,
    content?.imageMessage?.caption,
    content?.videoMessage?.caption,
    content?.documentMessage?.caption,
    content?.buttonsResponseMessage?.selectedDisplayText,
    content?.listResponseMessage?.title,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return undefined;
}

export function extractMentionedJids(message: RawWhatsAppMessage): string[] {
  const content = unwrapMessageContent(message.message);
  const contexts = [
    content?.extendedTextMessage?.contextInfo,
    content?.imageMessage?.contextInfo,
    content?.videoMessage?.contextInfo,
    content?.documentMessage?.contextInfo,
  ];
  const out: string[] = [];
  for (const ctx of contexts) {
    const mentions = ctx?.mentionedJid;
    if (!Array.isArray(mentions)) continue;
    for (const jid of mentions) {
      if (typeof jid === 'string' && jid.trim()) out.push(normalizeJid(jid));
    }
  }
  return out;
}

export function isBotMentioned(
  message: RawWhatsAppMessage,
  botJid: string | undefined,
  text: string,
): boolean {
  if (!botJid) return false;
  const normalizedBot = normalizeJid(botJid);
  if (extractMentionedJids(message).includes(normalizedBot)) return true;
  const phone = jidToPhone(normalizedBot);
  const digits = phone?.slice(1);
  return Boolean(digits && new RegExp(`@${digits}\\b`).test(text));
}

export function toIncomingMessage(
  message: RawWhatsAppMessage,
  botJid: string | undefined,
): WhatsAppIncomingMessage | undefined {
  if (message.key?.fromMe === true) return undefined;

  const chatJidRaw = message.key?.remoteJid;
  if (typeof chatJidRaw !== 'string' || !chatJidRaw.trim()) return undefined;
  if (isBroadcastJid(chatJidRaw)) return undefined;

  const text = extractText(message);
  const media = extractMedia(message);
  // Forward only if there's text/caption or a media attachment to download.
  if (!text && !media) return undefined;

  const chatJid = normalizeJid(chatJidRaw);
  const isGroup = isGroupJid(chatJid);
  const senderJid = normalizeJid(
    isGroup && typeof message.key?.participant === 'string'
      ? message.key.participant
      : chatJid,
  );
  // Mention detection runs over the caption text (empty for media-only).
  const mentioned = isGroup ? isBotMentioned(message, botJid, text ?? '') : true;

  return {
    chatJid,
    senderJid,
    ...(jidToPhone(senderJid) ? { senderNumber: jidToPhone(senderJid)! } : {}),
    ...(typeof message.pushName === 'string' && message.pushName.trim()
      ? { senderName: message.pushName.trim() }
      : {}),
    ...(typeof message.key?.id === 'string' ? { messageId: message.key.id } : {}),
    text: text ?? '',
    isGroup,
    mentioned,
    commandText: cleanBotCommandText(text ?? '', botJid),
    ...(media ? { media } : {}),
  };
}
