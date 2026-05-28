import type { WhatsAppBridge, WhatsAppIncomingMessage } from './bridge.js';
import { cleanBotCommandText, isBroadcastJid, isGroupJid, jidToPhone, normalizeJid } from './jid.js';
import type { RawWhatsAppMessage, WhatsAppApi } from './whatsapp-api.js';

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
      await this.options.bridge.handleIncoming(event);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log(`error handling message: ${msg}`);
    }
  }
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
  if (!text) return undefined;

  const chatJid = normalizeJid(chatJidRaw);
  const isGroup = isGroupJid(chatJid);
  const senderJid = normalizeJid(
    isGroup && typeof message.key?.participant === 'string'
      ? message.key.participant
      : chatJid,
  );
  const mentioned = isGroup ? isBotMentioned(message, botJid, text) : true;

  return {
    chatJid,
    senderJid,
    ...(jidToPhone(senderJid) ? { senderNumber: jidToPhone(senderJid)! } : {}),
    ...(typeof message.pushName === 'string' && message.pushName.trim()
      ? { senderName: message.pushName.trim() }
      : {}),
    ...(typeof message.key?.id === 'string' ? { messageId: message.key.id } : {}),
    text,
    isGroup,
    mentioned,
    commandText: cleanBotCommandText(text, botJid),
  };
}
