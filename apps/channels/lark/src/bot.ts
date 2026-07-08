/**
 * Lark bot. Two event delivery modes:
 *
 * - `ws` (default): the platform's WebSocket long connection — the SDK
 *   maintains and reconnects the socket; no public URL required.
 *   Constraint: Lark allows ONE live WS connection per app. Two gateways
 *   sharing an app_id fight over it ("system busy") — same failure family
 *   as Telegram's getUpdates Conflict. One Lark app per agent.
 *
 * - `webhook`: events arrive on the gateway's public webhook route
 *   (`…/channels/lark/webhook`). Lark has no programmatic setWebhook —
 *   the operator pastes the URL into the Developer Console. The handler
 *   answers the url_verification challenge synchronously and dispatches
 *   real events asynchronously (Lark retries on slow responses, so we
 *   ack fast; `message_id` dedup absorbs redeliveries).
 *
 * Both modes share the same EventDispatcher and normalization path.
 */
import {
  WSClient,
  EventDispatcher,
  Domain,
  LoggerLevel,
  generateChallenge,
} from '@larksuiteoapi/node-sdk';

import type { LarkApi } from './lark-api.js';
import type { LarkBridge, LarkInboundMessage } from './bridge.js';
import { isBotMentioned, parseMessageContent, stripMentionPlaceholders, type LarkMention } from './parse.js';

export interface LarkBotOptions {
  appId: string;
  appSecret: string;
  domainKey: 'feishu' | 'lark';
  mode: 'ws' | 'webhook';
  /** Webhook-mode Encrypt Key; enables event decryption + signature checks. */
  encryptKey?: string;
  /** Webhook-mode Verification Token. */
  verificationToken?: string;
  /** Public webhook URL, for operator guidance in the logs. */
  webhookUrl?: string;
  api: LarkApi;
  bridge: LarkBridge;
  logger?: (message: string) => void;
  reportRuntimeError?: (error: string | null) => void;
}

export interface WebhookRequestLike {
  headers: Record<string, string>;
  rawBody: string;
}

export interface WebhookResponseLike {
  status: number;
  body?: string;
  headers?: Record<string, string>;
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
  private readonly dispatcher: EventDispatcher;
  private ws: WSClient | undefined;
  private botOpenId: string | undefined;
  private readonly recentlyHandled = new Set<string>();

  constructor(private readonly options: LarkBotOptions) {
    this.log = options.logger ?? ((msg: string) => console.log(`[lark-bot] ${msg}`));
    this.dispatcher = new EventDispatcher({
      ...(options.encryptKey ? { encryptKey: options.encryptKey } : {}),
      ...(options.verificationToken ? { verificationToken: options.verificationToken } : {}),
      loggerLevel: LoggerLevel.error,
    }).register({
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

    if (this.options.mode === 'webhook') {
      this.log(
        `webhook mode — configure this Request URL in the Developer Console: ${
          this.options.webhookUrl ?? '(no public gateway URL configured!)'
        }`,
      );
      return;
    }

    this.ws = new WSClient({
      appId: this.options.appId,
      appSecret: this.options.appSecret,
      domain: this.options.domainKey === 'lark' ? Domain.Lark : Domain.Feishu,
      loggerLevel: LoggerLevel.error,
    });
    // start() is non-blocking; the SDK owns reconnection with backoff.
    this.ws.start({ eventDispatcher: this.dispatcher });
    this.log('websocket long connection started');
  }

  async stop(): Promise<void> {
    try {
      (this.ws as unknown as { close?: () => void })?.close?.();
    } catch { /* ignore */ }
    this.ws = undefined;
    this.log('bot stopped');
  }

  /**
   * Webhook-mode entry, called by the gateway dispatcher. Answers the
   * url_verification challenge synchronously; real events are verified +
   * decrypted by the SDK dispatcher and handled asynchronously so Lark
   * gets its ack well inside the retry window.
   */
  async handleWebhookRequest(req: WebhookRequestLike): Promise<WebhookResponseLike> {
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(req.rawBody) as Record<string, unknown>;
    } catch {
      return { status: 400, body: 'invalid json' };
    }

    // URL verification handshake (plaintext or encrypted).
    try {
      const { isChallenge, challenge } = generateChallenge(body as { encrypt?: string }, {
        encryptKey: this.options.encryptKey ?? '',
      });
      if (isChallenge) {
        return {
          status: 200,
          body: JSON.stringify(challenge),
          headers: { 'content-type': 'application/json' },
        };
      }
    } catch (err) {
      // Encrypted challenge but no/wrong encrypt key configured.
      const msg = err instanceof Error ? err.message : String(err);
      this.log(`webhook challenge failed: ${msg}`);
      return { status: 400, body: 'challenge failed' };
    }

    // Signature validation reads `data.headers` while JSON.stringify(data)
    // must reproduce the original body — keep headers on the prototype
    // (same trick as the SDK's own adapters).
    const invokeData = Object.assign(
      Object.create({ headers: req.headers }),
      body,
    ) as Record<string, unknown>;

    // Dispatch asynchronously: the agent turn can take minutes, Lark
    // redelivers on slow acks, and message_id dedup absorbs any repeats.
    void this.dispatcher.invoke(invokeData).catch((err) => {
      this.log(`webhook dispatch failed: ${err instanceof Error ? err.message : String(err)}`);
    });

    return { status: 200, body: '{"ok":true}', headers: { 'content-type': 'application/json' } };
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
