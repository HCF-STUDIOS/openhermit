/**
 * Bridge between Lark/Feishu messages and the OpenHermit agent API.
 * Mirrors the Slack bridge: per-chat session cache with DB recovery,
 * stale-session fallback, SSE turn wait, attachment delivery.
 */
import { randomUUID } from 'node:crypto';

import { AgentLocalClient, parseSseFrames } from '@openhermit/sdk';
import type { ChannelOutbound, ChannelOutboundResult, OutboundSession } from '@openhermit/protocol';
import { stripSilenceTokens, openSessionWithFreshFallback, startPersistentSubscription, outboundErrorText } from '@openhermit/shared';
import type { SseFrame } from '@openhermit/shared';

import type { LarkApi } from './lark-api.js';
import { chunkText } from './parse.js';

/** Gateway-enforced attachment cap (25 MiB). Skip oversized media early. */
const MAX_MEDIA_BYTES = 25 * 1024 * 1024;

interface TurnResult {
  text: string | undefined;
  error: string | undefined;
}

/** Normalized inbound message handed over by the bot layer. */
export interface LarkInboundMessage {
  chatId: string;
  chatType: 'p2p' | 'group';
  messageId: string;
  senderOpenId: string | undefined;
  senderName: string | undefined;
  text: string;
  mentioned: boolean;
  imageKey?: string;
  fileKey?: string;
  fileName?: string;
}

export class LarkBridge implements ChannelOutbound {
  readonly channel = 'lark';

  private readonly client: AgentLocalClient;
  private readonly clientToken: string;
  private readonly log: (message: string) => void;
  private readonly lastEventIds = new Map<string, number>();
  private readonly chatSessions = new Map<string, string>();
  /** Serialize turns per chat so one SSE watcher runs at a time. */
  private readonly chatLocks = new Map<string, Promise<void>>();
  /** Live out-of-turn subscriptions, one per session (see startAttachmentSubscription). */
  private readonly subscriptions = new Map<string, AbortController>();
  /** Persisted resume cursor per session, independent of the in-turn reader's. */
  private readonly subscriptionCursors = new Map<string, number>();

  constructor(
    private readonly lark: LarkApi,
    clientOptions: { baseUrl: string; token: string },
    logger?: (message: string) => void,
  ) {
    this.client = new AgentLocalClient(clientOptions);
    this.clientToken = clientOptions.token;
    this.log = logger ?? ((msg: string) => console.log(`[lark-bridge] ${msg}`));
  }

  // ── ChannelOutbound ────────────────────────────────────────────────

  async send(params: { sessionId: string; to: string; text: string }): Promise<ChannelOutboundResult> {
    try {
      let lastId: string | undefined;
      for (const chunk of chunkText(params.text)) {
        lastId = await this.lark.sendText(params.to, chunk);
      }
      const result: ChannelOutboundResult = { success: true };
      if (lastId) result.messageId = lastId;
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`failed to send message to ${params.to}: ${message}`);
      return { success: false, error: message };
    }
  }

  /** Recipient for `session_send`: the Lark chat id from session metadata. */
  resolveRecipient(session: OutboundSession): string | undefined {
    const v = session.metadata?.lark_chat_id;
    return typeof v === 'string' && v ? v : undefined;
  }

  // ── Sessions ───────────────────────────────────────────────────────

  private static generateSessionId(): string {
    return `lark:${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`;
  }

  private async getSessionId(chatId: string): Promise<string> {
    const cached = this.chatSessions.get(chatId);
    if (cached) return cached;

    try {
      const sessions = await this.client.listSessions({
        channel: 'lark',
        metadata: { lark_chat_id: chatId },
        limit: 1,
      });
      if (sessions.length > 0) {
        const sessionId = sessions[0]!.sessionId;
        this.chatSessions.set(chatId, sessionId);
        return sessionId;
      }
    } catch {
      // Server unavailable — fall through to generate a new session.
    }

    const sessionId = LarkBridge.generateSessionId();
    this.chatSessions.set(chatId, sessionId);
    return sessionId;
  }

  async handleNewSession(chatId: string): Promise<void> {
    const fresh = LarkBridge.generateSessionId();
    this.chatSessions.set(chatId, fresh);
    await this.lark.sendText(chatId, 'New conversation started.');
  }

  private async ensureSession(sessionId: string, msg: LarkInboundMessage): Promise<void> {
    const metadata: Record<string, string> = {
      lark_chat_id: msg.chatId,
      lark_chat_type: msg.chatType,
    };
    if (msg.chatType === 'p2p') {
      if (msg.senderOpenId) metadata.lark_user_id = msg.senderOpenId;
      if (msg.senderName) metadata.lark_user_name = msg.senderName;
    }

    await this.client.openSession({
      sessionId,
      source: {
        kind: 'channel',
        interactive: true,
        platform: 'lark',
        type: msg.chatType === 'p2p' ? 'direct' : 'group',
      },
      metadata,
    });
  }

  // ── Inbound ────────────────────────────────────────────────────────

  async handleMessage(msg: LarkInboundMessage): Promise<void> {
    const previous = this.chatLocks.get(msg.chatId) ?? Promise.resolve();
    const turn = previous.then(() => this.handleMessageInner(msg));
    this.chatLocks.set(msg.chatId, turn.catch(() => undefined));
    await turn;
  }

  private async handleMessageInner(msg: LarkInboundMessage): Promise<void> {
    let sessionId = await this.getSessionId(msg.chatId);

    // A recovered session id may no longer be reopenable (stale/migrated,
    // or a different resolved identity) — fall back to a fresh session.
    sessionId = await openSessionWithFreshFallback(
      sessionId,
      (id) => this.ensureSession(id, msg),
      () => {
        const fresh = LarkBridge.generateSessionId();
        this.chatSessions.set(msg.chatId, fresh);
        return fresh;
      },
    );

    // Keep an out-of-turn subscription open so media/errors the server pushes
    // after a turn are still delivered. Idempotent per session.
    this.startAttachmentSubscription(sessionId, msg.chatId);

    const attachments = await this.resolveInboundMedia(sessionId, msg);
    if (!msg.text && attachments.length === 0) return;

    const postResult = await this.client.postMessage(sessionId, {
      text: msg.text,
      mentioned: msg.mentioned,
      ...(attachments.length > 0 ? { attachments } : {}),
      ...(msg.senderOpenId
        ? {
            sender: {
              channel: 'lark',
              channelUserId: msg.senderOpenId,
              ...(msg.senderName ? { displayName: msg.senderName } : {}),
            },
          }
        : {}),
    });

    if (!(postResult as { triggered?: boolean }).triggered) return;

    const result = await this.waitForAgentResponse(sessionId);

    if (result.error && !result.text) {
      await this.lark.sendText(msg.chatId, `Error: ${result.error}`);
    } else if (result.text) {
      await this.send({ sessionId, to: msg.chatId, text: result.text });
    }
  }

  /** Download inbound image/file and re-upload as a session attachment. */
  private async resolveInboundMedia(
    sessionId: string,
    msg: LarkInboundMessage,
  ): Promise<{ type: 'file'; id: string }[]> {
    const key = msg.imageKey ?? msg.fileKey;
    if (!key) return [];
    try {
      const bytes = await this.lark.downloadResource(
        msg.messageId,
        key,
        msg.imageKey ? 'image' : 'file',
      );
      if (bytes.byteLength > MAX_MEDIA_BYTES) {
        this.log(`skipping oversized inbound media (${bytes.byteLength} bytes)`);
        return [];
      }
      const filename = msg.fileName ?? (msg.imageKey ? 'image.png' : 'attachment');
      const blob = new Blob([bytes as unknown as BlobPart]);
      const uploaded = await this.client.uploadAttachment(sessionId, blob, filename);
      return uploaded.id ? [{ type: 'file', id: uploaded.id }] : [];
    } catch (err) {
      this.log(`inbound media failed: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  /**
   * Start the out-of-turn subscription delivering `attachment` and out-of-band
   * `error` events pushed after a turn. Idempotent per sessionId. Attachment
   * delivery happens only here, never in the per-turn loop, so it stays
   * exactly-once. Mirrors the other channel bridges.
   */
  private startAttachmentSubscription(sessionId: string, chatId: string): void {
    if (this.subscriptions.has(sessionId)) return;

    const abortController = new AbortController();
    this.subscriptions.set(sessionId, abortController);
    const release = (): void => {
      if (this.subscriptions.get(sessionId) === abortController) {
        this.subscriptions.delete(sessionId);
      }
    };

    void startPersistentSubscription({
      eventsUrl: this.client.buildEventsUrl(sessionId),
      headers: { authorization: `Bearer ${this.clientToken}` },
      abortSignal: abortController.signal,
      lastEventId: this.subscriptionCursors.get(sessionId) ?? 0,
      onCursorAdvance: (cursor) => this.subscriptionCursors.set(sessionId, cursor),
      onEnding: release,
      onEvent: (frame: SseFrame) => {
        if (frame.event === 'error') {
          const text = outboundErrorText(frame.data);
          if (text) {
            void this.lark.sendText(chatId, text).catch((err) => {
              this.log(`out-of-turn error delivery failed: ${err instanceof Error ? err.message : String(err)}`);
            });
          }
          return;
        }
        // pending_media has nothing to render in a text channel; ignore it.
        if (frame.event !== 'attachment') return;
        try {
          const payload = frame.data.length > 0
            ? (JSON.parse(frame.data) as Record<string, unknown>)
            : {};
          void this.deliverAttachment(chatId, payload).catch((err) => {
            this.log(`out-of-turn attachment delivery failed: ${err instanceof Error ? err.message : String(err)}`);
          });
        } catch (err) {
          this.log(`failed to parse out-of-turn attachment event: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
    }).catch((err) => {
      this.log(`persistent subscription for ${sessionId} ended: ${err instanceof Error ? err.message : String(err)}`);
    }).finally(release);
  }

  /** Number of live persistent subscriptions. Exposed for tests. */
  get subscriptionCount(): number {
    return this.subscriptions.size;
  }

  /** Stop all persistent subscriptions. Called on bridge/adapter shutdown. */
  stop(): void {
    for (const controller of this.subscriptions.values()) {
      controller.abort();
    }
    this.subscriptions.clear();
  }

  // ── Turn wait (SSE) ────────────────────────────────────────────────

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

          const payload = frame.data.length > 0
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
            // A correlationId marks a media-placeholder resolver, not a turn
            // failure; text channels have no placeholder, so skip it.
            if (typeof payload.correlationId === 'string' && payload.correlationId) continue;
            error = String(payload.message ?? 'Unknown error');
            continue;
          }
          // Attachments are delivered only by the persistent subscription;
          // handling them here too would double every in-turn attachment.
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

    const rawResponseText = finalText ?? (accumulatedText.trim() || undefined);
    const stripped = rawResponseText !== undefined ? stripSilenceTokens(rawResponseText) : undefined;
    if (stripped?.isSilent) return { text: undefined, error: undefined };
    const responseText = stripped?.hadToken ? stripped.text : rawResponseText;

    return { text: responseText, error };
  }

  /**
   * Deliver an outbound `attachment` SSE event to the chat. Bytes are
   * pulled lazily from the agent-local API; images go out as native Lark
   * image messages, everything else as a file.
   */
  private async deliverAttachment(chatId: string, payload: Record<string, unknown>): Promise<void> {
    const sessionId = String(payload.sessionId ?? '');
    const attachmentId = String(payload.attachmentId ?? '');
    if (!sessionId || !attachmentId) {
      this.log('attachment event missing sessionId/attachmentId');
      return;
    }
    const caption =
      typeof payload.caption === 'string' && payload.caption.length > 0
        ? payload.caption
        : undefined;
    const hintedKind = String(payload.kind ?? '');
    const hintedName =
      typeof payload.name === 'string' && payload.name.length > 0 ? payload.name : undefined;

    const { bytes, mimeType, kind: resolvedKind, filename } =
      await this.client.downloadAttachmentBytes(sessionId, attachmentId);
    const kind = hintedKind || resolvedKind || '';
    const name = hintedName ?? filename ?? 'attachment';

    if (kind === 'image' || mimeType?.startsWith('image/')) {
      const imageKey = await this.lark.uploadImage(bytes);
      if (!imageKey) throw new Error('lark image upload returned no image_key');
      await this.lark.sendImage(chatId, imageKey);
    } else {
      const fileKey = await this.lark.uploadFile(bytes, name);
      if (!fileKey) throw new Error('lark file upload returned no file_key');
      await this.lark.sendFile(chatId, fileKey);
    }
    if (caption) await this.lark.sendText(chatId, caption);
  }
}
