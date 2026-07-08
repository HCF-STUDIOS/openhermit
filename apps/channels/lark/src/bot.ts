/**
 * Lark bot. Receives events over the platform's WebSocket long connection
 * (no public URL required — the SDK maintains and reconnects the socket),
 * normalizes `im.message.receive_v1`, and forwards to the bridge.
 *
 * Constraint worth knowing: Lark allows ONE live WS connection per app.
 * Running two gateways against the same app_id makes them fight (the
 * platform reports "system busy"), same failure family as Telegram's
 * getUpdates Conflict — use one Lark app per agent.
 */
import { WSClient, EventDispatcher, Domain, LoggerLevel } from '@larksuiteoapi/node-sdk';

import type { LarkApi } from './lark-api.js';
import type { LarkBridge, LarkInboundMessage } from './bridge.js';
import { isBotMentioned, parseMessageContent, stripMentionPlaceholders, type LarkMention } from './parse.js';

export interface LarkBotOptions {
  appId: string;
  appSecret: string;
  domainKey: 'feishu' | 'lark';
  api: LarkApi;
  bridge: LarkBridge;
  logger?: (message: string) => void;
  reportRuntimeError?: (error: string | null) => void;
}

/** The subset of the `im.message.receive_v1` event payload we consume. */
interface ReceiveEvent {
  sender?: {
    sender_id?: { open_id?: string };
    sender_type?: string;
  };
  message?: {
    message_id?: string;
    chat_id?: string;
    chat_type?: string;
    message_type?: string;
    content?: string;
    mentions?: LarkMention[];
  };
}

export class LarkBot {
  private readonly log: (message: string) => void;
  private ws: WSClient | undefined;
  private botOpenId: string | undefined;
  private readonly recentlyHandled = new Set<string>();

  constructor(private readonly options: LarkBotOptions) {
    this.log = options.logger ?? ((msg: string) => console.log(`[lark-bot] ${msg}`));
  }

  async start(): Promise<void> {
    try {
      const info = await this.options.api.getBotInfo();
      this.botOpenId = info.openId;
      this.log(`connected as ${info.appName ?? 'bot'} (${info.openId ?? 'unknown open_id'})`);
      this.options.reportRuntimeError?.(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Bad credentials fail here — surface but keep starting so the
      // channels list shows the error rather than a silent no-op.
      this.log(`bot info failed (check app_id/app_secret + bot capability): ${msg}`);
      this.options.reportRuntimeError?.(`bot info failed: ${msg}`);
    }

    const dispatcher = new EventDispatcher({}).register({
      'im.message.receive_v1': async (data: unknown) => {
        try {
          await this.handleReceive(data as ReceiveEvent);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.log(`error handling message: ${msg}`);
          const chatId = (data as ReceiveEvent).message?.chat_id;
          if (chatId) {
            await this.options.api
              .sendText(chatId, 'Sorry, something went wrong. Please try again.')
              .catch(() => undefined);
          }
        }
      },
    });

    this.ws = new WSClient({
      appId: this.options.appId,
      appSecret: this.options.appSecret,
      domain: this.options.domainKey === 'lark' ? Domain.Lark : Domain.Feishu,
      loggerLevel: LoggerLevel.error,
    });
    // start() is non-blocking; the SDK owns reconnection with backoff.
    this.ws.start({ eventDispatcher: dispatcher });
    this.log('websocket long connection started');
  }

  async stop(): Promise<void> {
    try {
      (this.ws as unknown as { close?: () => void })?.close?.();
    } catch { /* ignore */ }
    this.ws = undefined;
    this.log('bot stopped');
  }

  private async handleReceive(event: ReceiveEvent): Promise<void> {
    const message = event.message;
    if (!message?.chat_id || !message.message_id) return;

    // Only human senders; the bot's own outbound (and other apps) echo as
    // sender_type 'app'.
    if (event.sender?.sender_type && event.sender.sender_type !== 'user') return;

    // Lark delivery is at-least-once — dedupe by message_id.
    if (this.recentlyHandled.has(message.message_id)) return;
    this.recentlyHandled.add(message.message_id);
    setTimeout(() => this.recentlyHandled.delete(message.message_id!), 60_000);

    const chatType: 'p2p' | 'group' = message.chat_type === 'group' ? 'group' : 'p2p';
    const parsed = parseMessageContent(message.message_type ?? '', message.content ?? '');
    if (parsed.unsupported && !parsed.imageKey && !parsed.fileKey) {
      this.log(`skipping unsupported message_type=${message.message_type}`);
      return;
    }

    const mentioned = isBotMentioned(chatType, message.mentions, this.botOpenId);
    const text = stripMentionPlaceholders(parsed.text, message.mentions, this.botOpenId);

    if (mentioned && (text === 'new' || text === '/new')) {
      await this.options.bridge.handleNewSession(message.chat_id);
      return;
    }

    const senderOpenId = event.sender?.sender_id?.open_id;

    const inbound: LarkInboundMessage = {
      chatId: message.chat_id,
      chatType,
      messageId: message.message_id,
      senderOpenId,
      // Resolving display names needs contact:user scopes — v2 concern.
      senderName: undefined,
      text,
      mentioned,
      ...(parsed.imageKey ? { imageKey: parsed.imageKey } : {}),
      ...(parsed.fileKey ? { fileKey: parsed.fileKey } : {}),
      ...(parsed.fileName ? { fileName: parsed.fileName } : {}),
    };

    await this.options.bridge.handleMessage(inbound);
  }
}
