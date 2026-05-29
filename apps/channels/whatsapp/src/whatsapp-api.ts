import makeWASocket, {
  DisconnectReason,
  downloadMediaMessage,
} from 'baileys';
import type { ChannelCredentialStore } from '@openhermit/protocol';
import pino from 'pino';

import { normalizeJid, targetToJid } from './jid.js';
import { useDbAuthState } from './db-auth-state.js';

export type RawWhatsAppMessage = Record<string, any>;
export type RawWhatsAppMessageHandler = (message: RawWhatsAppMessage) => void | Promise<void>;

/** Outbound media payload routed to the right Baileys message content. */
export interface WhatsAppOutboundMedia {
  bytes: Uint8Array;
  mimeType: string;
  kind: 'image' | 'audio' | 'video' | 'document';
  filename: string;
  caption?: string;
}

export interface WhatsAppApiOptions {
  authProfile: string;
  credentialStore: ChannelCredentialStore;
  logger?: (message: string) => void;
  reportRuntimeError?: (error: string | null) => void;
  reconnectDelayMs?: number;
}

export class WhatsAppApi {
  private readonly log: (message: string) => void;
  private readonly reportRuntimeError: (error: string | null) => void;
  private readonly reconnectDelayMs: number;
  private sock: any;
  private running = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private messageHandler: RawWhatsAppMessageHandler | undefined;
  botJid: string | undefined;

  constructor(private readonly options: WhatsAppApiOptions) {
    this.log = options.logger ?? ((msg) => console.log(`[whatsapp-api] ${msg}`));
    this.reportRuntimeError = options.reportRuntimeError ?? (() => undefined);
    this.reconnectDelayMs = options.reconnectDelayMs ?? 3000;
  }

  onMessage(handler: RawWhatsAppMessageHandler): void {
    this.messageHandler = handler;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.connect();
    } catch (err) {
      this.running = false;
      throw err;
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    await this.closeSocket();
    this.log('socket stopped');
  }

  async sendText(target: string, text: string): Promise<{ messageId?: string }> {
    if (!this.sock) throw new Error('WhatsApp socket is not connected');
    const jid = targetToJid(target);
    const sent = await this.sock.sendMessage(jid, { text });
    const messageId = sent?.key?.id;
    return typeof messageId === 'string' ? { messageId } : {};
  }

  /**
   * Send a media attachment. The `kind` picks the Baileys content shape
   * (image/video/document/audio). ogg/opus audio is sent as a push-to-talk
   * voice note; WhatsApp audio messages do not carry captions.
   */
  async sendMedia(target: string, media: WhatsAppOutboundMedia): Promise<{ messageId?: string }> {
    if (!this.sock) throw new Error('WhatsApp socket is not connected');
    const jid = targetToJid(target);
    const buffer = Buffer.from(media.bytes);
    const caption = media.caption && media.caption.length > 0 ? media.caption : undefined;

    let content: Record<string, unknown>;
    if (media.kind === 'image') {
      content = { image: buffer, mimetype: media.mimeType, ...(caption ? { caption } : {}) };
    } else if (media.kind === 'video') {
      content = { video: buffer, mimetype: media.mimeType, ...(caption ? { caption } : {}) };
    } else if (media.kind === 'audio') {
      // Strip MIME parameters (e.g. `audio/ogg; codecs=opus`) before matching.
      const baseMime = media.mimeType.split(';', 1)[0]!.trim().toLowerCase();
      const ptt = baseMime === 'audio/ogg' || baseMime === 'audio/opus';
      content = { audio: buffer, mimetype: media.mimeType, ...(ptt ? { ptt: true } : {}) };
    } else {
      content = {
        document: buffer,
        mimetype: media.mimeType,
        fileName: media.filename,
        ...(caption ? { caption } : {}),
      };
    }

    const sent = await this.sock.sendMessage(jid, content);
    const messageId = sent?.key?.id;
    return typeof messageId === 'string' ? { messageId } : {};
  }

  /**
   * Download the media bytes for an inbound message via Baileys. `rawMessage`
   * must be the full `WAMessage` (key + message) delivered by `messages.upsert`.
   */
  async downloadMedia(rawMessage: RawWhatsAppMessage): Promise<Buffer> {
    if (!this.sock) throw new Error('WhatsApp socket is not connected');
    const buffer = await downloadMediaMessage(
      rawMessage as never,
      'buffer',
      {},
      {
        logger: pino({ level: 'silent' }) as never,
        reuploadRequest: this.sock.updateMediaMessage,
      },
    );
    return buffer;
  }

  private async connect(): Promise<void> {
    const { state, saveCreds } = await useDbAuthState(
      this.options.credentialStore,
      this.options.authProfile,
    );
    const creds = state.creds as { me?: { id?: string }; noiseKey?: unknown };
    if (!creds.me?.id || !creds.noiseKey) {
      this.running = false;
      throw new Error('WhatsApp auth is not linked; run channel setup first.');
    }

    const sock = makeWASocket({
      auth: state,
      logger: pino({ level: 'silent' }),
      markOnlineOnConnect: false,
      getMessage: async () => undefined,
    });

    this.sock = sock;
    if (sock.user?.id) this.botJid = normalizeJid(String(sock.user.id));

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', (update: Record<string, any>) => {
      this.handleConnectionUpdate(update);
    });
    sock.ev.on('messages.upsert', (update: Record<string, any>) => {
      const messages = Array.isArray(update.messages) ? update.messages : [];
      for (const message of messages) {
        void this.messageHandler?.(message);
      }
    });
  }

  private handleConnectionUpdate(update: Record<string, any>): void {
    if (update.connection === 'open') {
      if (this.sock?.user?.id) this.botJid = normalizeJid(String(this.sock.user.id));
      this.reportRuntimeError(null);
      this.log(`connected${this.botJid ? ` as ${this.botJid}` : ''}`);
      return;
    }

    if (update.connection !== 'close') return;

    const statusCode = Number(
      update.lastDisconnect?.error?.output?.statusCode ??
      update.lastDisconnect?.error?.statusCode ??
      0,
    );
    const message = update.lastDisconnect?.error instanceof Error
      ? update.lastDisconnect.error.message
      : String(update.lastDisconnect?.error ?? 'connection closed');

    if (statusCode === DisconnectReason.loggedOut) {
      this.running = false;
      this.reportRuntimeError('WhatsApp logged out; run channel setup again.');
      this.log('logged out; setup is required before reconnecting');
      return;
    }

    if (!this.running) return;
    this.reportRuntimeError(`WhatsApp connection closed: ${message}`);
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (!this.running) return;
      void this.closeSocket()
        .then(() => this.connect())
        .catch((err) => {
          const message = err instanceof Error ? err.message : String(err);
          this.reportRuntimeError(`WhatsApp reconnect failed: ${message}`);
          this.log(`reconnect failed: ${message}`);
          if (this.running) this.scheduleReconnect();
        });
    }, this.reconnectDelayMs);
  }

  private async closeSocket(): Promise<void> {
    const sock = this.sock;
    this.sock = undefined;
    if (!sock) return;
    try {
      sock.ev?.removeAllListeners?.();
    } catch {
      // ignore
    }
    try {
      sock.end?.(undefined);
    } catch {
      try {
        sock.ws?.close?.();
      } catch {
        // ignore
      }
    }
  }
}
