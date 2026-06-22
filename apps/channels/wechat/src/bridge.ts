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
import {
  MessageItemType,
  MessageType,
  VoiceEncodeType,
  type ImageItem,
  type VoiceItem,
  type WeixinMessage,
} from './ilink/types.js';
import { CDN_BASE_URL, downloadAndDecrypt, resolveCdnUrl } from './ilink/media.js';
import { SILK_SAMPLE_RATE, silkToWav, toSilk } from './ilink/silk.js';
import { uploadVoiceToCdn } from './ilink/upload.js';

/**
 * Marker prepended to a transcribed voice note. It both tells the agent the
 * user spoke and asks for a speech-friendly reply, since when the inbound was
 * voice we try to answer with a voice note.
 */
const VOICE_MARKER =
  '[Voice message, transcribed. Your reply will be converted to speech, so respond in ' +
  'plain prose without code blocks, markdown formatting, or long lists.]';

/** Cap on text we'll synthesize into a voice reply — longer stays text. */
const VOICE_MAX_TEXT_LENGTH = 1000;

/** Whether a reply is fit for voice delivery (mirrors the Telegram bridge). */
const shouldSpeak = (text: string): boolean => {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  if (trimmed.length > VOICE_MAX_TEXT_LENGTH) return false;
  if (trimmed.includes('```')) return false;
  return true;
};

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
  /** True when at least one voice note contributed (transcribed) text. */
  wasVoice?: boolean;
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

  /**
   * Synthesize `text` to speech, encode it to SILK, upload it to the WeChat
   * CDN, and send it as a native voice note. Returns `true` on success; on any
   * failure (TTS unavailable, unspeakable content, encode/upload/send error)
   * it returns `false` so the caller falls back to a text reply.
   *
   * NOTE: the reference `openclaw-weixin` has no outbound voice path, so the
   * `voice_item` shape and the SILK encode params are unverified against the
   * live protocol. The graceful fallback keeps a wrong guess from breaking the
   * conversation — worst case the user gets text instead of a voice note.
   */
  private async trySendVoiceReply(
    toUserId: string,
    text: string,
    turnContextToken?: string,
  ): Promise<boolean> {
    if (!shouldSpeak(text)) return false;
    try {
      // ElevenLabs `audio/pcm` → pcm_24000 (mono s16le, 24 kHz) — exactly what
      // silk-wasm's encoder wants, and matches WeChat's SILK sample rate.
      const tts = await this.client.synthesizeAudio({ text, outputMimeType: 'audio/pcm' });
      const encoded = await toSilk(tts.bytes, SILK_SAMPLE_RATE);
      if (!encoded) {
        this.log('voice reply: silk encode failed; falling back to text');
        return false;
      }

      const uploaded = await uploadVoiceToCdn({
        baseUrl: this.runtime.baseUrl,
        token: this.runtime.botToken,
        bytes: encoded.silk,
        toUserId,
      });

      return await this.sendVoice(toUserId, uploaded, encoded.durationMs, turnContextToken);
    } catch (err) {
      this.log(`voice reply failed for ${toUserId}: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /** Send an already-uploaded SILK clip as a WeChat voice note. */
  private async sendVoice(
    toUserId: string,
    uploaded: { downloadEncryptedQueryParam: string; aeskeyHex: string },
    durationMs: number,
    turnContextToken?: string,
  ): Promise<boolean> {
    const contextToken = turnContextToken ?? this.peerContextTokens.get(toUserId);
    const voiceItem: VoiceItem = {
      media: {
        encrypt_query_param: uploaded.downloadEncryptedQueryParam,
        // Match how images encode the key on outbound: base64 of the hex string.
        aes_key: Buffer.from(uploaded.aeskeyHex, 'ascii').toString('base64'),
        encrypt_type: 1,
      },
      encode_type: VoiceEncodeType.SILK,
      sample_rate: SILK_SAMPLE_RATE,
      bits_per_sample: 16,
      playtime: Math.round(durationMs),
    };
    const msg: WeixinMessage = {
      to_user_id: toUserId,
      message_type: MessageType.BOT,
      client_id: randomUUID(),
      create_time_ms: Date.now(),
      item_list: [{ type: MessageItemType.VOICE, voice_item: voiceItem }],
      ...(contextToken ? { context_token: contextToken } : {}),
    };
    try {
      await sendMessage({
        baseUrl: this.runtime.baseUrl,
        token: this.runtime.botToken,
        body: { msg },
      });
      return true;
    } catch (err) {
      this.log(`failed to send voice to ${toUserId}: ${err instanceof Error ? err.message : String(err)}`);
      return false;
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
    const parts: string[] = [];
    const base = this.extractText(msg);
    if (base) parts.push(base);

    const ids: { type: 'file'; id: string }[] = [];
    let wasVoice = false;

    for (const item of msg.item_list ?? []) {
      if (item.type === MessageItemType.IMAGE && item.image_item) {
        const id = await this.resolveImage(sessionId, item.image_item);
        if (id) ids.push(id);
      } else if (item.type === MessageItemType.VOICE && item.voice_item) {
        const transcript = await this.resolveVoice(item.voice_item);
        if (transcript) {
          parts.push(transcript);
          wasVoice = true;
        }
      }
    }

    return {
      text: parts.join('\n'),
      wasVoice,
      ...(ids.length > 0 ? { attachments: ids } : {}),
    };
  }

  /** Download + decrypt an inbound image and upload it as a session attachment. */
  private async resolveImage(
    sessionId: string,
    img: ImageItem,
  ): Promise<{ type: 'file'; id: string } | undefined> {
    const media = img.media;
    if (!media || (!media.full_url && !media.encrypt_query_param)) return undefined;

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
      return undefined;
    }

    try {
      const url = resolveCdnUrl(media.encrypt_query_param, media.full_url, CDN_BASE_URL);
      const bytes = await downloadAndDecrypt({ url, aesKeyBase64, maxBytes: MAX_MEDIA_BYTES });
      const blob = new Blob([bytes as unknown as BlobPart], { type: 'image/jpeg' });
      const uploaded = await this.client.uploadAttachment(sessionId, blob, 'image.jpg');
      return { type: 'file', id: uploaded.id! };
    } catch (err) {
      this.log(`image download/decrypt failed: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  }

  /**
   * Resolve an inbound voice note to transcribed text. Prefers WeChat's own
   * transcript when present; otherwise downloads + decrypts the SILK clip,
   * transcodes it to WAV, and runs the agent's STT. Returns `undefined` on any
   * failure so the turn proceeds with whatever other content it has.
   */
  private async resolveVoice(voice: VoiceItem): Promise<string | undefined> {
    // WeChat sometimes pre-transcribes the clip — use it and skip the download.
    const pre = voice.text?.trim();
    if (pre) return pre;

    // We only decode SILK; any other codec would just fail after download.
    if (voice.encode_type !== undefined && voice.encode_type !== VoiceEncodeType.SILK) {
      this.log(`voice encode_type ${voice.encode_type} is not SILK; skipping`);
      return undefined;
    }

    const media = voice.media;
    if (!media || (!media.full_url && !media.encrypt_query_param) || !media.aes_key) {
      this.log('voice item missing CDN ref or aes key; skipping');
      return undefined;
    }

    try {
      const url = resolveCdnUrl(media.encrypt_query_param, media.full_url, CDN_BASE_URL);
      const silk = await downloadAndDecrypt({
        url,
        aesKeyBase64: media.aes_key,
        maxBytes: MAX_MEDIA_BYTES,
      });
      const decoded = await silkToWav(silk, voice.sample_rate || SILK_SAMPLE_RATE);
      if (!decoded) {
        this.log('voice silk decode failed; skipping');
        return undefined;
      }
      const stt = await this.client.transcribeAudio({ bytes: decoded.wav, mimeType: 'audio/wav' });
      return stt.text.trim() || undefined;
    } catch (err) {
      this.log(`voice transcription failed: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  }

  private async handleMessageInner(msg: WeixinMessage, peer: string): Promise<void> {
    const hasMedia = (msg.item_list ?? []).some(
      (item) =>
        (item.type === MessageItemType.IMAGE && item.image_item) ||
        (item.type === MessageItemType.VOICE && item.voice_item),
    );
    if (!this.extractText(msg) && !hasMedia) return;

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

    // Tag transcribed voice so the agent knows the user spoke (and, once
    // outbound voice lands, that a spoken reply is appropriate).
    const agentText =
      resolved.wasVoice && resolved.text ? `${VOICE_MARKER}\n\n${resolved.text}` : resolved.text;

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
      text: agentText,
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
        const outText = stripped.hadToken ? stripped.text : replyText;
        // When the user sent voice (DM only), answer with a voice note; fall
        // back to text if TTS/encode/upload/send fails or the text isn't
        // speakable. Group replies always stay text.
        const sentVoice =
          resolved.wasVoice && !isGroup
            ? await this.trySendVoiceReply(peer, outText, turnContextToken)
            : false;
        if (!sentVoice) {
          await this.sendText(peer, outText, turnContextToken);
        }
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
