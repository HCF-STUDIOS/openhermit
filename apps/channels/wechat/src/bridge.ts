/**
 * Bridge between iLink WeChat messages and the OpenHermit agent API.
 *
 * Translates inbound `WeixinMessage` (text-only) into agent session
 * interactions, mirrors the per-chat serialization the Telegram bridge
 * uses, and implements `ChannelOutbound` so the `session_send` tool can
 * push proactive replies via iLink.
 */
import { randomUUID } from 'node:crypto';

import { AgentLocalClient, parseSseFrames } from '@openhermit/sdk';
import type {
  ChannelMessageAction,
  ChannelOutbound,
  ChannelOutboundResult,
} from '@openhermit/protocol';
import { stripSilenceTokens } from '@openhermit/shared';

import { sendMessage } from './ilink/api.js';
import { MessageItemType, MessageType, type WeixinMessage } from './ilink/types.js';
import { CDN_BASE_URL, downloadAndDecrypt, resolveCdnUrl } from './ilink/media.js';

/** Gateway-enforced attachment cap (25 MiB). Skip oversized media early. */
const MAX_MEDIA_BYTES = 25 * 1024 * 1024;

interface TurnResult {
  text: string | undefined;
  error: string | undefined;
}

/** Outcome of resolving an inbound message's media. */
interface ResolvedInbound {
  text: string;
  attachments?: { type: 'file'; id: string }[];
}

export interface WechatBridgeRuntime {
  /** iLink per-bot base URL (returned at QR login confirm). */
  baseUrl: string;
  /** iLink bot token (returned at QR login confirm). */
  botToken: string;
  /** Our own bot user id; used to skip echoed self-messages. */
  ilinkBotId?: string;
}

export class WechatBridge implements ChannelOutbound {
  readonly channel = 'wechat';

  private readonly client: AgentLocalClient;
  private readonly clientToken: string;
  private readonly log: (message: string) => void;
  private readonly lastEventIds = new Map<string, number>();
  /** sessionId per peer (DM peer id or group id). */
  private readonly peerSessions = new Map<string, string>();
  /** Per-peer message queue to serialize handling. */
  private readonly peerLocks = new Map<string, Promise<void>>();
  /**
   * Latest iLink `context_token` per peer. Issued per-message on inbound and
   * echoed verbatim on outbound sends so replies stay tied to the upstream
   * conversation context. In-memory only — after a restart the first
   * proactive send to a peer goes without a token until they message again.
   */
  private readonly peerContextTokens = new Map<string, string>();

  constructor(
    private runtime: WechatBridgeRuntime,
    clientOptions: { baseUrl: string; token: string },
    logger?: (message: string) => void,
  ) {
    this.client = new AgentLocalClient(clientOptions);
    this.clientToken = clientOptions.token;
    this.log = logger ?? ((msg) => console.log(`[wechat-bridge] ${msg}`));
  }

  /** Update iLink credentials in-place (e.g. after a re-login). */
  updateRuntime(runtime: WechatBridgeRuntime): void {
    this.runtime = runtime;
  }

  // ── ChannelOutbound ──────────────────────────────────────────────

  async send(params: {
    sessionId: string;
    to: string;
    text: string;
    actions?: ChannelMessageAction[];
  }): Promise<ChannelOutboundResult> {
    // v0 ignores `actions` — iLink has no inline-button equivalent we use yet.
    void params.actions;
    return this.sendText(params.to, params.text);
  }

  private async sendText(
    toUserId: string,
    text: string,
    turnContextToken?: string,
  ): Promise<ChannelOutboundResult> {
    const trimmed = text.trim();
    if (!trimmed) return { success: true };

    // Replies pass the token snapshotted at their turn's start so a newer
    // inbound message can't swap it; proactive sends (session_send) fall back
    // to the latest known token for the peer.
    const contextToken = turnContextToken ?? this.peerContextTokens.get(toUserId);
    const msg: WeixinMessage = {
      to_user_id: toUserId,
      message_type: MessageType.BOT,
      client_id: randomUUID(),
      create_time_ms: Date.now(),
      item_list: [
        { type: MessageItemType.TEXT, text_item: { text: trimmed } },
      ],
      ...(contextToken ? { context_token: contextToken } : {}),
    };

    try {
      await sendMessage({
        baseUrl: this.runtime.baseUrl,
        token: this.runtime.botToken,
        body: { msg },
      });
      return { success: true, messageId: msg.client_id ?? '' };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log(`failed to send message to ${toUserId}: ${message}`);
      return { success: false, error: message };
    }
  }

  // ── Inbound ──────────────────────────────────────────────────────

  /** Entry point for the bot loop; serializes per-peer. */
  async handleMessage(msg: WeixinMessage): Promise<void> {
    // Skip our own outbound echoes.
    if (msg.message_type === MessageType.BOT) return;

    const peer = msg.group_id?.trim() || msg.from_user_id?.trim();
    if (!peer) return;

    // Capture the per-message context token so our reply can echo it.
    const contextToken = msg.context_token?.trim();
    if (contextToken) this.peerContextTokens.set(peer, contextToken);

    const prev = this.peerLocks.get(peer) ?? Promise.resolve();
    const current = prev.then(
      () => this.handleMessageInner(msg, peer),
      () => this.handleMessageInner(msg, peer),
    );
    this.peerLocks.set(peer, current.catch(() => {}));
    await current;
  }

  private extractText(msg: WeixinMessage): string | undefined {
    if (!msg.item_list) return undefined;
    const parts: string[] = [];
    for (const item of msg.item_list) {
      const text = item.text_item?.text;
      if (text && text.trim()) parts.push(text.trim());
    }
    return parts.length > 0 ? parts.join('\n') : undefined;
  }

  /**
   * Resolve inbound media: download + decrypt each image item from the CDN
   * and upload it as a durable session attachment (images become vision
   * input). Text/captions are kept. Oversized or failed downloads are skipped.
   */
  private async resolveInbound(sessionId: string, msg: WeixinMessage): Promise<ResolvedInbound> {
    const text = this.extractText(msg) ?? '';
    const ids: { type: 'file'; id: string }[] = [];

    for (const item of msg.item_list ?? []) {
      if (item.type !== MessageItemType.IMAGE || !item.image_item) continue;
      const img = item.image_item;
      const media = img.media;
      if (!media || (!media.full_url && !media.encrypt_query_param)) continue;

      // Prefer the hex `aeskey` (raw 16-byte key = 32 hex chars), but only when
      // it's actually valid hex — otherwise Buffer.from(...,'hex') would
      // silently truncate to a wrong key. Fall back to the base64 media.aes_key.
      let aesKeyBase64: string | undefined;
      const hexKey = img.aeskey?.trim();
      if (hexKey && /^[0-9a-fA-F]{32}$/.test(hexKey)) {
        aesKeyBase64 = Buffer.from(hexKey, 'hex').toString('base64');
      } else {
        if (hexKey) this.log('image aeskey is not valid 16-byte hex; falling back to media.aes_key');
        aesKeyBase64 = media.aes_key;
      }
      if (!aesKeyBase64) {
        this.log('image item missing aes key; skipping');
        continue;
      }

      try {
        const url = resolveCdnUrl(media.encrypt_query_param, media.full_url, CDN_BASE_URL);
        const bytes = await downloadAndDecrypt({ url, aesKeyBase64, maxBytes: MAX_MEDIA_BYTES });
        const blob = new Blob([bytes as unknown as BlobPart], { type: 'image/jpeg' });
        const uploaded = await this.client.uploadAttachment(sessionId, blob, 'image.jpg');
        ids.push({ type: 'file', id: uploaded.id! });
      } catch (err) {
        this.log(`image download/decrypt failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return { text, ...(ids.length > 0 ? { attachments: ids } : {}) };
  }

  private async handleMessageInner(msg: WeixinMessage, peer: string): Promise<void> {
    const hasImage = (msg.item_list ?? []).some(
      (item) => item.type === MessageItemType.IMAGE && item.image_item,
    );
    if (!this.extractText(msg) && !hasImage) return;

    // Snapshot this turn's context token up front so the reply echoes the
    // token of the message it's answering, even if a newer message for the
    // same peer arrives and overwrites the shared map mid-turn.
    const turnContextToken = msg.context_token?.trim();

    const isGroup = Boolean(msg.group_id?.trim());
    const sessionId = await this.getSessionId(peer, isGroup);
    await this.ensureSession(sessionId, msg, isGroup);

    // Download + decrypt inbound images and upload them as session
    // attachments (images become vision input). Text/captions are kept.
    const resolved = await this.resolveInbound(sessionId, msg);
    if (!resolved.text && !resolved.attachments) return;

    const senderUserId = msg.from_user_id?.trim();
    const senderPayload = senderUserId
      ? {
          sender: {
            channel: 'wechat' as const,
            channelUserId: senderUserId,
          },
        }
      : {};

    // DMs: surface the caller via `x-channel-user-id` so the runtime resolves a
    // session-level channel identity (currentChannel/currentChannelUserId).
    // Without it, tools like identity_link_request fail with "requires a known
    // caller channel". Groups stay per-message (no session-level claim).
    const postOpts = !isGroup && senderUserId ? { channelUserId: senderUserId } : undefined;

    const postResult = await this.client.postMessage(sessionId, {
      text: resolved.text,
      mentioned: !isGroup,
      ...(resolved.attachments ? { attachments: resolved.attachments } : {}),
      ...senderPayload,
    }, postOpts);

    if (!(postResult as { triggered?: boolean }).triggered) return;

    const result = await this.waitForAgentResponse(sessionId);
    const replyText = result.text;
    if (result.error && !replyText) {
      await this.sendText(peer, `Error: ${result.error}`, turnContextToken);
      return;
    }
    if (replyText) {
      const stripped = stripSilenceTokens(replyText);
      if (!stripped.isSilent) {
        await this.sendText(peer, stripped.hadToken ? stripped.text : replyText, turnContextToken);
      }
    }
  }

  private static generateSessionId(): string {
    return `wechat:${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`;
  }

  private async getSessionId(peer: string, isGroup: boolean): Promise<string> {
    const cached = this.peerSessions.get(peer);
    if (cached) return cached;

    try {
      const sessions = await this.client.listSessions({
        channel: 'wechat',
        metadata: { [isGroup ? 'wechat_group_id' : 'wechat_peer_id']: peer },
        limit: 1,
      });
      if (sessions.length > 0) {
        const sessionId = sessions[0]!.sessionId;
        this.peerSessions.set(peer, sessionId);
        return sessionId;
      }
    } catch {
      // Server unavailable — fall through.
    }

    const sessionId = WechatBridge.generateSessionId();
    this.peerSessions.set(peer, sessionId);
    return sessionId;
  }

  private async ensureSession(
    sessionId: string,
    msg: WeixinMessage,
    isGroup: boolean,
  ): Promise<void> {
    const metadata: Record<string, string | number> = {};
    if (isGroup && msg.group_id) metadata.wechat_group_id = msg.group_id;
    if (!isGroup && msg.from_user_id) metadata.wechat_peer_id = msg.from_user_id;
    if (msg.from_user_id) metadata.wechat_from_user_id = msg.from_user_id;

    // DMs: claim a session-level caller identity (see handleMessageInner).
    const senderUserId = msg.from_user_id?.trim();
    const openOpts = !isGroup && senderUserId ? { channelUserId: senderUserId } : undefined;

    await this.client.openSession({
      sessionId,
      source: {
        kind: 'channel',
        interactive: true,
        platform: 'wechat',
        type: isGroup ? 'group' : 'direct',
      },
      ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    }, openOpts);
  }

  private async waitForAgentResponse(sessionId: string): Promise<TurnResult> {
    const eventsUrl = this.client.buildEventsUrl(sessionId);
    const lastEventId = this.lastEventIds.get(sessionId) ?? 0;

    const response = await fetch(eventsUrl, {
      headers: { authorization: `Bearer ${this.clientToken}` },
    });

    if (!response.ok || !response.body) {
      return { text: undefined, error: `Failed to open event stream (${response.status})` };
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let nextLastEventId = lastEventId;
    let sequenceResetChecked = false;
    let accumulatedText = '';
    let finalText: string | undefined;
    let error: string | undefined;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parsed = parseSseFrames(buffer);
        buffer = parsed.remainder;
        let sawAgentEnd = false;

        for (const frame of parsed.frames) {
          if (frame.id !== undefined && frame.id <= nextLastEventId) continue;
          if (frame.id !== undefined) nextLastEventId = frame.id;

          if (frame.event === 'ready') {
            if (!sequenceResetChecked) {
              sequenceResetChecked = true;
              try {
                const data = frame.data.length > 0
                  ? (JSON.parse(frame.data) as { nextEventId?: number })
                  : {};
                if (typeof data.nextEventId === 'number' && data.nextEventId <= nextLastEventId) {
                  nextLastEventId = 0;
                }
              } catch { /* ignore */ }
            }
            continue;
          }
          if (frame.event === 'ping') continue;

          const payload =
            frame.data.length > 0
              ? (JSON.parse(frame.data) as Record<string, unknown>)
              : {};

          if (frame.event === 'text_delta') {
            accumulatedText += String(payload.text ?? '');
            continue;
          }
          if (frame.event === 'text_final') {
            finalText = String(payload.text ?? '').trim();
            continue;
          }
          if (frame.event === 'error') {
            error = String(payload.message ?? 'Unknown error');
            continue;
          }
          if (frame.event === 'agent_end') {
            sawAgentEnd = true;
            continue;
          }
        }
        if (sawAgentEnd) break;
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }

    this.lastEventIds.set(sessionId, nextLastEventId);
    const text = finalText ?? (accumulatedText.trim() || undefined);
    return { text, error };
  }
}
