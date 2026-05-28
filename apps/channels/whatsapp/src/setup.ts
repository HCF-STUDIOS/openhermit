import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
} from 'baileys';
import pino from 'pino';
import type {
  ChannelSetup,
  ChannelSetupContext,
  ChannelSetupState,
} from '@openhermit/protocol';

const SESSION_TTL_MS = 10 * 60 * 1000;

export interface WhatsAppLinkSnapshot {
  kind: 'awaiting' | 'done' | 'error';
  qrText?: string;
  message?: string;
}

export interface WhatsAppLinkSession {
  authDir: string;
  read(): Promise<WhatsAppLinkSnapshot>;
  cancel(): Promise<void>;
}

export type StartWhatsAppLinkSession = (opts: {
  authDir: string;
  agentId: string;
  logger: (message: string) => void;
}) => Promise<WhatsAppLinkSession>;

export interface CreateWhatsAppSetupOptions {
  startLinkSession?: StartWhatsAppLinkSession;
}

interface PendingSession {
  createdAt: number;
  link: WhatsAppLinkSession;
}

export function expandHome(input: string): string {
  if (input === '~') return os.homedir();
  if (input.startsWith('~/')) return path.join(os.homedir(), input.slice(2));
  return input;
}

export function collapseHome(input: string): string {
  const home = os.homedir();
  if (input === home) return '~';
  if (input.startsWith(`${home}${path.sep}`)) return `~/${input.slice(home.length + 1)}`;
  return input;
}

export function defaultAuthDir(agentId: string, account = 'default'): string {
  const safeAgentId = agentId.replace(/[^a-zA-Z0-9_.-]/g, '_');
  const safeAccount = account.replace(/[^a-zA-Z0-9_.-]/g, '_');
  return path.join(os.homedir(), '.openhermit', 'credentials', 'whatsapp', safeAgentId, safeAccount);
}

class BaileysLinkSession implements WhatsAppLinkSession {
  private sock: any;
  private qrText: string | undefined;
  private done = false;
  private error: string | undefined;

  constructor(
    readonly authDir: string,
    private readonly agentId: string,
    private readonly logger: (message: string) => void,
  ) {}

  async start(): Promise<void> {
    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
    const credsArePaired = (): boolean => {
      const creds = state.creds as { me?: { id?: string }; noiseKey?: unknown };
      return Boolean(creds.me?.id && creds.noiseKey);
    };
    if (credsArePaired()) {
      this.done = true;
      return;
    }

    const deviceName = `OpenHermit · ${this.agentId}`.slice(0, 64);
    const sock = makeWASocket({
      auth: state,
      browser: [deviceName, 'Desktop', '1.0.0'],
      logger: pino({ level: process.env.WHATSAPP_DEBUG === '1' ? 'debug' : 'silent' }),
      markOnlineOnConnect: false,
      getMessage: async () => undefined,
    });
    this.sock = sock;
    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', (update: Record<string, any>) => {
      if (typeof update.qr === 'string' && update.qr.length > 0) {
        this.qrText = update.qr;
      }
      if (update.connection === 'open') {
        this.done = true;
        this.logger('WhatsApp QR login confirmed');
      }
      if (update.connection === 'close' && !this.done) {
        const statusCode = Number(
          update.lastDisconnect?.error?.output?.statusCode ??
          update.lastDisconnect?.error?.statusCode ??
          0,
        );
        if (statusCode === DisconnectReason.restartRequired && credsArePaired()) {
          this.done = true;
          this.logger('WhatsApp QR login confirmed (restart required after pair)');
          return;
        }
        if (statusCode === DisconnectReason.loggedOut) {
          this.error = 'WhatsApp login was logged out before linking completed.';
        } else {
          const message = update.lastDisconnect?.error instanceof Error
            ? update.lastDisconnect.error.message
            : String(update.lastDisconnect?.error ?? 'connection closed');
          this.error = `WhatsApp linking connection closed: ${message}`;
        }
      }
    });
  }

  async read(): Promise<WhatsAppLinkSnapshot> {
    if (this.error) return { kind: 'error', message: this.error };
    if (this.done) return { kind: 'done' };
    return this.qrText
      ? { kind: 'awaiting', qrText: this.qrText }
      : { kind: 'awaiting' };
  }

  async cancel(): Promise<void> {
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

export const startRealWhatsAppLinkSession: StartWhatsAppLinkSession = async ({
  authDir,
  agentId,
  logger,
}) => {
  const session = new BaileysLinkSession(authDir, agentId, logger);
  await session.start();
  return session;
};

export const createWhatsAppSetup = (
  opts: CreateWhatsAppSetupOptions = {},
): ChannelSetup => {
  const sessions = new Map<string, PendingSession>();
  const startLinkSession = opts.startLinkSession ?? startRealWhatsAppLinkSession;

  const isExpired = (s: PendingSession): boolean =>
    Date.now() - s.createdAt > SESSION_TTL_MS;

  const cleanup = async (sessionId: string, session: PendingSession): Promise<void> => {
    sessions.delete(sessionId);
    await session.link.cancel().catch(() => undefined);
  };

  const sweepExpired = async (): Promise<void> => {
    const expired: Array<[string, PendingSession]> = [];
    for (const [id, session] of sessions) {
      if (isExpired(session)) expired.push([id, session]);
    }
    await Promise.all(expired.map(([id, session]) => cleanup(id, session)));
  };

  const toState = async (
    sessionId: string,
    ctx: ChannelSetupContext,
  ): Promise<ChannelSetupState> => {
    const session = sessions.get(sessionId);
    if (!session || isExpired(session)) {
      if (session) await cleanup(sessionId, session);
      return { kind: 'error', message: 'WhatsApp setup session not found or expired.' };
    }

    const snap = await session.link.read();
    if (snap.kind === 'error') {
      await cleanup(sessionId, session);
      return { kind: 'error', message: snap.message ?? 'WhatsApp setup failed.' };
    }
    if (snap.kind === 'done') {
      const authDir = collapseHome(session.link.authDir);
      await cleanup(sessionId, session);
      ctx.logger(`WhatsApp linked with auth_dir=${authDir}`);
      return {
        kind: 'done',
        config: { auth_dir: authDir },
      };
    }

    return {
      kind: 'awaiting_external',
      instructions: snap.qrText
        ? 'Open WhatsApp on your phone and scan this QR from Linked devices.'
        : 'Starting WhatsApp linking session...',
      ...(snap.qrText ? { qrText: snap.qrText } : {}),
      pollIntervalMs: 1500,
    };
  };

  return {
    begin: async (input, ctx) => {
      await sweepExpired();
      const sessionId = randomUUID();
      const rawAuthDir = typeof input.auth_dir === 'string' && input.auth_dir.trim()
        ? input.auth_dir.trim()
        : defaultAuthDir(ctx.agentId);
      const authDir = expandHome(rawAuthDir);
      const link = await startLinkSession({
        authDir,
        agentId: ctx.agentId,
        logger: (message) => ctx.logger(message),
      });
      sessions.set(sessionId, { createdAt: Date.now(), link });
      return { sessionId, state: await toState(sessionId, ctx) };
    },

    poll: async (sessionId, ctx) => {
      await sweepExpired();
      return toState(sessionId, ctx);
    },

    cancel: async (sessionId) => {
      await sweepExpired();
      const session = sessions.get(sessionId);
      if (session) await cleanup(sessionId, session);
    },
  };
};
