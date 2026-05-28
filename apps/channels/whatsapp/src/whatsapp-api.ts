import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
} from 'baileys';
import pino from 'pino';

import { normalizeJid, targetToJid } from './jid.js';

export type RawWhatsAppMessage = Record<string, any>;
export type RawWhatsAppMessageHandler = (message: RawWhatsAppMessage) => void | Promise<void>;

export interface WhatsAppApiOptions {
  authDir: string;
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

  private async connect(): Promise<void> {
    const { state, saveCreds } = await useMultiFileAuthState(this.options.authDir);
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
