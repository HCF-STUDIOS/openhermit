import { randomUUID } from 'node:crypto';

import { AgentLocalClient, parseSseFrames } from '@openhermit/sdk';
import type { ChannelOutbound, ChannelOutboundResult, OutboundSession } from '@openhermit/protocol';
import { stripSilenceTokens, openSessionWithFreshFallback, startPersistentSubscription, outboundErrorText } from '@openhermit/shared';
import type { SseFrame } from '@openhermit/shared';

import type { SlackApi, SlackMessageEvent } from './slack-api.js';
import { formatAgentResponse, markdownToSlackMrkdwn } from './formatting.js';

/** Gateway-enforced attachment cap (25 MiB). Skip oversized media early. */
const MAX_MEDIA_BYTES = 25 * 1024 * 1024;

interface TurnResult {
  text: string | undefined;
  error: string | undefined;
}

/** Outcome of resolving an inbound message's Slack files. */
interface ResolvedInbound {
  text: string;
  attachments?: { type: 'file'; id: string }[];
}

export class SlackBridge implements ChannelOutbound {
  readonly channel = 'slack';

  private readonly client: AgentLocalClient;
  private readonly clientToken: string;
  private readonly log: (message: string) => void;
  private readonly lastEventIds = new Map<string, number>();
  /** Out-of-turn subscriptions by sessionId; sole owner of attachment delivery (per-turn loop no longer delivers, so no double-delivery). */
  private readonly subscriptions = new Map<string, AbortController>();
  /** Highest out-of-turn id delivered per sessionId. Survives idle-close/reopen so a reopened subscription doesn't redeliver the replayed backlog. */
  private readonly subscriptionCursors = new Map<string, number>();
  private readonly channelSessions = new Map<string, string>();

  constructor(
    private readonly slack: SlackApi,
    clientOptions: { baseUrl: string; token: string },
    logger?: (message: string) => void,
  ) {
    this.client = new AgentLocalClient(clientOptions);
    this.clientToken = clientOptions.token;
    this.log = logger ?? ((msg: string) => console.log(`[slack-bridge] ${msg}`));
  }

  async send(params: { sessionId: string; to: string; text: string }): Promise<ChannelOutboundResult> {
    try {
      const chunks = formatAgentResponse(params.text);
      let lastTs: string | undefined;
      for (const chunk of chunks) {
        const sent = await this.slack.sendMessage(params.to, chunk);
        lastTs = sent.ts;
      }
      const result: ChannelOutboundResult = { success: true };
      if (lastTs) result.messageId = lastTs;
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`failed to send message to ${params.to}: ${message}`);
      return { success: false, error: message };
    }
  }

  /** Recipient for `session_send`: the Slack channel id from session metadata. */
  resolveRecipient(session: OutboundSession): string | undefined {
    const v = session.metadata?.slack_channel_id;
    return typeof v === 'string' && v ? v : undefined;
  }

  private static generateSessionId(): string {
    return `slack:${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`;
  }

  private sessionKey(channelId: string, threadTs?: string): string {
    return threadTs ? `${channelId}:${threadTs}` : channelId;
  }

  private async getSessionId(channelId: string, threadTs?: string): Promise<string> {
    const key = this.sessionKey(channelId, threadTs);
    const cached = this.channelSessions.get(key);
    if (cached) return cached;

    try {
      const metadata: Record<string, string> = { slack_channel_id: channelId };
      if (threadTs) metadata.slack_thread_ts = threadTs;
      const sessions = await this.client.listSessions({
        channel: 'slack',
        metadata,
        limit: 1,
      });
      if (sessions.length > 0) {
        const sessionId = sessions[0]!.sessionId;
        this.channelSessions.set(key, sessionId);
        return sessionId;
      }
    } catch {
      // Fall through to generate new session.
    }

    const sessionId = SlackBridge.generateSessionId();
    this.channelSessions.set(key, sessionId);
    return sessionId;
  }

  async handleMessage(event: SlackMessageEvent & { mentioned?: boolean }): Promise<void> {
    const channelId = event.channel;
    const text = event.text?.trim() ?? '';
    const hasFiles = Array.isArray(event.files) && event.files.length > 0;

    if ((!text && !hasFiles) || !event.user) return;

    const threadTs = event.thread_ts;
    const isDm = event.channel_type === 'im';
    const mentioned = event.mentioned ?? isDm;
    const sessionId = await this.getSessionId(channelId, threadTs);

    await this.sendToAgent(channelId, sessionId, text, event, isDm, mentioned, threadTs);
  }

  /**
   * Download each inbound Slack file (url_private needs bot-token auth) and
   * either transcribe it (audio) or upload it as a durable session attachment.
   */
  private async resolveInbound(
    sessionId: string,
    event: SlackMessageEvent,
    baseText: string,
  ): Promise<ResolvedInbound> {
    let text = baseText;
    const ids: { type: 'file'; id: string }[] = [];
    const transcripts: string[] = [];

    for (const file of event.files ?? []) {
      const url = file.url_private_download ?? file.url_private;
      if (!url) continue;
      if (file.size && file.size > MAX_MEDIA_BYTES) {
        this.log(`skipping oversized file ${file.name ?? file.id} (${file.size} bytes)`);
        continue;
      }
      let bytes: Uint8Array;
      try {
        bytes = await this.slack.downloadFile(url, MAX_MEDIA_BYTES);
      } catch (err) {
        this.log(`failed to download file ${file.name ?? file.id}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      const mime = file.mimetype ?? 'application/octet-stream';
      const filename = file.name ?? `${file.id}.${file.filetype ?? 'bin'}`;
      if (mime.startsWith('audio/')) {
        try {
          const { text: transcript } = await this.client.transcribeAudio({ bytes, mimeType: mime });
          if (transcript.trim()) transcripts.push(transcript.trim());
        } catch (err) {
          this.log(`stt failed for ${filename}: ${err instanceof Error ? err.message : String(err)}`);
        }
      } else {
        try {
          const blob = new Blob([bytes as unknown as BlobPart], { type: mime });
          const uploaded = await this.client.uploadAttachment(sessionId, blob, filename);
          ids.push({ type: 'file', id: uploaded.id! });
        } catch (err) {
          this.log(`upload failed for ${filename}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    if (transcripts.length > 0) {
      const joined = transcripts.join('\n\n');
      text = text ? `${text}\n\n[Transcribed voice message]\n${joined}` : `[Transcribed voice message]\n${joined}`;
    }

    return { text, ...(ids.length > 0 ? { attachments: ids } : {}) };
  }

  async handleNewSession(channelId: string, threadTs?: string): Promise<void> {
    const key = this.sessionKey(channelId, threadTs);
    const oldSessionId = this.channelSessions.get(key);

    if (oldSessionId) {
      try {
        await this.client.checkpointSession(oldSessionId, { reason: 'new_session' });
      } catch { /* ignore */ }
      this.lastEventIds.delete(oldSessionId);
      this.subscriptionCursors.delete(oldSessionId);
      // Stop the orphaned subscription so it doesn't poll the dead session until idle timeout.
      this.subscriptions.get(oldSessionId)?.abort();
      this.subscriptions.delete(oldSessionId);
    }

    const newSessionId = SlackBridge.generateSessionId();
    this.channelSessions.set(key, newSessionId);
    await this.slack.sendMessage(channelId, 'New conversation started.', ...(threadTs ? [{ threadTs }] : []));
  }

  private async sendToAgent(
    channelId: string,
    sessionId: string,
    text: string,
    event: SlackMessageEvent,
    isDm: boolean,
    mentioned: boolean,
    threadTs?: string,
  ): Promise<void> {
    // A recovered session id may no longer be reopenable (stale/migrated, or
    // a different resolved identity) — the agent API returns 404 Session not
    // found. Fall back to a fresh session instead of failing the message.
    sessionId = await openSessionWithFreshFallback(
      sessionId,
      (id) => this.ensureSession(id, event, isDm, threadTs),
      () => {
        // Match handleNewSession: drop cursor/state and stop polling the abandoned session.
        this.lastEventIds.delete(sessionId);
        this.subscriptionCursors.delete(sessionId);
        this.subscriptions.get(sessionId)?.abort();
        this.subscriptions.delete(sessionId);
        const fresh = SlackBridge.generateSessionId();
        this.channelSessions.set(this.sessionKey(channelId, threadTs), fresh);
        return fresh;
      },
    );

    let displayName: string | undefined;
    if (event.user) {
      try {
        const userInfo = await this.slack.getUserInfo(event.user);
        displayName = userInfo.real_name || userInfo.name;
      } catch { /* ignore */ }
    }

    const resolved = await this.resolveInbound(sessionId, event, text);
    // Nothing usable (e.g. all files failed to download and no text).
    if (!resolved.text && !resolved.attachments) return;

    const postResult = await this.client.postMessage(sessionId, {
      text: resolved.text,
      mentioned,
      ...(resolved.attachments ? { attachments: resolved.attachments } : {}),
      ...(event.user ? {
        sender: {
          channel: 'slack',
          channelUserId: event.user,
          ...(displayName ? { displayName } : {}),
        },
      } : {}),
    });

    if (!(postResult as any).triggered) return;

    const result = await this.waitForAgentResponse(sessionId, channelId, threadTs);

    if (result.error && !result.text) {
      await this.slack.sendMessage(channelId, `Error: ${result.error}`, ...(threadTs ? [{ threadTs }] : []));
    } else if (result.text) {
      await this.send({ sessionId, to: channelId, text: result.text });
    }
  }

  /**
   * Deliver an outbound `attachment` SSE event as a Slack file upload.
   * Bytes are pulled lazily from the agent-local API.
   */
  private async deliverAttachment(
    channelId: string,
    payload: Record<string, unknown>,
    threadTs?: string,
  ): Promise<void> {
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
    const hintedName =
      typeof payload.name === 'string' && payload.name.length > 0 ? payload.name : undefined;

    const { bytes, filename } = await this.client.downloadAttachmentBytes(sessionId, attachmentId);
    await this.slack.uploadFile(channelId, {
      bytes,
      filename: hintedName ?? filename ?? 'attachment',
      ...(caption ? { caption } : {}),
      ...(threadTs ? { threadTs } : {}),
    });
  }

  private async ensureSession(
    sessionId: string,
    event: SlackMessageEvent,
    isDm: boolean,
    threadTs?: string,
  ): Promise<void> {
    const metadata: Record<string, string> = {
      slack_channel_id: event.channel,
    };
    if (threadTs) metadata.slack_thread_ts = threadTs;
    if (event.user) metadata.slack_user_id = event.user;

    await this.client.openSession({
      sessionId,
      source: {
        kind: 'channel',
        interactive: true,
        platform: 'slack',
        type: isDm ? 'direct' : 'group',
      },
      metadata,
    });

    this.startAttachmentSubscription(sessionId, event.channel, threadTs);
  }

  /**
   * Start the out-of-turn subscription delivering `attachment` events pushed
   * after a turn. Idempotent per sessionId. Sole owner of attachment delivery.
   * Cursor advances before the upload finishes, so delivery is at-most-once
   * (a failed upload is not retried), not a durability guarantee.
   */
  private startAttachmentSubscription(
    sessionId: string,
    channelId: string,
    threadTs?: string,
    idleTimeoutMs?: number,
  ): void {
    if (this.subscriptions.has(sessionId)) return;

    const abortController = new AbortController();
    this.subscriptions.set(sessionId, abortController);
    // Drop map entry as soon as idle decides to end (onEnding) and again in
    // finally for abort/other ends. Identity guard so a concurrent reopen
    // that already replaced this controller is never evicted.
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
      ...(idleTimeoutMs !== undefined ? { idleTimeoutMs } : {}),
      onEvent: (frame: SseFrame) => {
        if (frame.event === 'error') {
          const text = outboundErrorText(frame.data);
          if (text) {
            void this.slack.sendMessage(channelId, text, ...(threadTs ? [{ threadTs }] : [])).catch((err) => {
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
          void this.deliverAttachment(channelId, payload, threadTs).catch((err) => {
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

  private async waitForAgentResponse(
    sessionId: string,
    channelId: string,
    threadTs?: string,
  ): Promise<TurnResult> {
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

    let sentTs: string | undefined;
    let lastEditTime = 0;
    const EDIT_THROTTLE_MS = 1500;

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
            // Strip mid-stream too so a token can't flash before the final edit.
            const displayText = stripSilenceTokens(accumulatedText).text;

            const now = Date.now();
            if (!sentTs && displayText.length > 0) {
              try {
                const sent = await this.slack.sendMessage(
                  channelId,
                  markdownToSlackMrkdwn(displayText) + ' ...',
                  ...(threadTs ? [{ threadTs }] : []),
                );
                sentTs = sent.ts;
                lastEditTime = now;
              } catch { /* will send final at end */ }
            } else if (sentTs && now - lastEditTime >= EDIT_THROTTLE_MS) {
              void this.slack.updateMessage(
                channelId,
                sentTs,
                markdownToSlackMrkdwn(displayText) + ' ...',
              ).catch(() => undefined);
              lastEditTime = now;
            }
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

          // Delivered only by the persistent subscription; handling it here too would double every in-turn attachment.

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
    const stripped =
      rawResponseText !== undefined ? stripSilenceTokens(rawResponseText) : undefined;

    if (stripped?.isSilent) {
      if (sentTs) {
        void this.slack.web.chat.delete({ channel: channelId, ts: sentTs }).catch(() => undefined);
      }
      return { text: undefined, error: undefined };
    }

    const responseText = stripped?.hadToken ? stripped.text : rawResponseText;

    if (sentTs && responseText) {
      try {
        await this.slack.updateMessage(channelId, sentTs, markdownToSlackMrkdwn(responseText));
      } catch {
        void this.slack.updateMessage(channelId, sentTs, responseText).catch(() => undefined);
      }
    }

    return {
      text: sentTs ? undefined : responseText,
      error,
    };
  }
}
