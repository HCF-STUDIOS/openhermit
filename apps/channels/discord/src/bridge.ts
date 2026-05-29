import { randomUUID } from 'node:crypto';

import { AgentLocalClient, parseSseFrames } from '@openhermit/sdk';
import type { ChannelOutbound, ChannelOutboundResult } from '@openhermit/protocol';
import { stripSilenceTokens } from '@openhermit/shared';

import type { DiscordApi, DiscordMessageEvent } from './discord-api.js';
import { formatAgentResponse, markdownToDiscord } from './formatting.js';

/** Gateway-enforced attachment cap (25 MiB). Skip oversized media early. */
const MAX_MEDIA_BYTES = 25 * 1024 * 1024;

/** Bound CDN attachment fetches so a stalled connection can't block the queue. */
const MEDIA_FETCH_TIMEOUT_MS = 15_000;

interface TurnResult {
  text: string | undefined;
  error: string | undefined;
}

/** Outcome of resolving an inbound message's attachments. */
interface ResolvedInbound {
  text: string;
  attachments?: { type: 'file'; id: string }[];
}

export class DiscordBridge implements ChannelOutbound {
  readonly channel = 'discord';

  private readonly client: AgentLocalClient;
  private readonly clientToken: string;
  private readonly log: (message: string) => void;
  private readonly lastEventIds = new Map<string, number>();
  private readonly channelSessions = new Map<string, string>();
  private readonly turnQueues = new Map<string, Promise<void>>();

  constructor(
    private readonly discord: DiscordApi,
    clientOptions: { baseUrl: string; token: string },
    logger?: (message: string) => void,
  ) {
    this.client = new AgentLocalClient(clientOptions);
    this.clientToken = clientOptions.token;
    this.log = logger ?? ((msg: string) => console.log(`[discord-bridge] ${msg}`));
  }

  async send(params: { sessionId: string; to: string; text: string }): Promise<ChannelOutboundResult> {
    try {
      const chunks = formatAgentResponse(params.text);
      let lastMessageId: string | undefined;
      for (const chunk of chunks) {
        const sent = await this.discord.sendMessage(params.to, chunk);
        lastMessageId = sent.id;
      }
      const result: ChannelOutboundResult = { success: true };
      if (lastMessageId) result.messageId = lastMessageId;
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`failed to send message to ${params.to}: ${message}`);
      return { success: false, error: message };
    }
  }

  private static generateSessionId(): string {
    return `discord:${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`;
  }

  private async getSessionId(channelId: string): Promise<string> {
    const cached = this.channelSessions.get(channelId);
    if (cached) return cached;

    try {
      const sessions = await this.client.listSessions({
        channel: 'discord',
        metadata: { discord_channel_id: channelId },
        limit: 1,
      });
      if (sessions.length > 0) {
        const sessionId = sessions[0]!.sessionId;
        this.channelSessions.set(channelId, sessionId);
        return sessionId;
      }
    } catch {
      // Fall through to generate new session.
    }

    const sessionId = DiscordBridge.generateSessionId();
    this.channelSessions.set(channelId, sessionId);
    return sessionId;
  }

  async handleMessage(event: DiscordMessageEvent): Promise<void> {
    const text = event.text.trim();
    if (!text && !(event.attachments && event.attachments.length > 0)) return;

    const sessionId = await this.getSessionId(event.channelId);
    await this.runInChannelQueue(event.channelId, () => this.sendToAgent(event, sessionId, text));
  }

  /**
   * Fetch each inbound attachment from the Discord CDN and either transcribe
   * it (audio) or upload it as a durable session attachment (everything else).
   */
  private async resolveInbound(
    sessionId: string,
    event: DiscordMessageEvent,
    baseText: string,
  ): Promise<ResolvedInbound> {
    let text = baseText;
    const ids: { type: 'file'; id: string }[] = [];
    const transcripts: string[] = [];

    for (const att of event.attachments ?? []) {
      if (att.size && att.size > MAX_MEDIA_BYTES) {
        this.log(`skipping oversized attachment ${att.name} (${att.size} bytes)`);
        continue;
      }
      let bytes: Uint8Array;
      try {
        // Bound the CDN fetch so a stalled connection can't block the queue.
        const res = await fetch(att.url, { signal: AbortSignal.timeout(MEDIA_FETCH_TIMEOUT_MS) });
        if (!res.ok) throw new Error(`status ${res.status}`);
        bytes = new Uint8Array(await res.arrayBuffer());
      } catch (err) {
        this.log(`failed to fetch attachment ${att.name}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      const mime = att.contentType ?? 'application/octet-stream';
      if (mime.startsWith('audio/')) {
        try {
          const { text: transcript } = await this.client.transcribeAudio({ bytes, mimeType: mime });
          if (transcript.trim()) transcripts.push(transcript.trim());
        } catch (err) {
          this.log(`stt failed for ${att.name}: ${err instanceof Error ? err.message : String(err)}`);
        }
      } else {
        try {
          const blob = new Blob([bytes as unknown as BlobPart], { type: mime });
          const uploaded = await this.client.uploadAttachment(sessionId, blob, att.name);
          ids.push({ type: 'file', id: uploaded.id! });
        } catch (err) {
          this.log(`upload failed for ${att.name}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    if (transcripts.length > 0) {
      const joined = transcripts.join('\n\n');
      text = text ? `${text}\n\n[Transcribed voice message]\n${joined}` : `[Transcribed voice message]\n${joined}`;
    }

    return { text, ...(ids.length > 0 ? { attachments: ids } : {}) };
  }

  private async runInChannelQueue(channelId: string, task: () => Promise<void>): Promise<void> {
    const previousTurn = this.turnQueues.get(channelId);
    const currentTurn = this.runAfterPreviousTurn(previousTurn, task).finally(() => {
      if (this.turnQueues.get(channelId) === currentTurn) {
        this.turnQueues.delete(channelId);
      }
    });

    this.turnQueues.set(channelId, currentTurn);
    await currentTurn;
  }

  private async runAfterPreviousTurn(
    previousTurn: Promise<void> | undefined,
    task: () => Promise<void>,
  ): Promise<void> {
    if (previousTurn) {
      try {
        await previousTurn;
      } catch {
        // Keep later Discord messages flowing after a failed turn.
      }
    }

    await task();
  }

  async handleNewSession(channelId: string): Promise<void> {
    const oldSessionId = this.channelSessions.get(channelId);

    if (oldSessionId) {
      try {
        await this.client.checkpointSession(oldSessionId, { reason: 'new_session' });
      } catch { /* ignore */ }
      this.lastEventIds.delete(oldSessionId);
    }

    const newSessionId = DiscordBridge.generateSessionId();
    this.channelSessions.set(channelId, newSessionId);
    await this.discord.sendMessage(channelId, 'New conversation started.');
  }

  private async sendToAgent(
    event: DiscordMessageEvent,
    sessionId: string,
    text: string,
  ): Promise<void> {
    await this.ensureSession(sessionId, event);

    const resolved = await this.resolveInbound(sessionId, event, text);
    // Nothing usable (e.g. all attachments failed to fetch and no text).
    if (!resolved.text && !resolved.attachments) return;

    const postResult = await this.client.postMessage(sessionId, {
      text: resolved.text,
      mentioned: event.mentioned,
      ...(resolved.attachments ? { attachments: resolved.attachments } : {}),
      sender: {
        channel: 'discord',
        channelUserId: event.userId,
        displayName: event.displayName,
      },
    });

    if (!(postResult as any).triggered) return;

    void this.discord.startTyping(event.channelId);

    const result = await this.waitForAgentResponse(sessionId, event.channelId);

    if (result.error && !result.text) {
      await this.discord.sendMessage(event.channelId, `Error: ${result.error}`);
    } else if (result.text) {
      await this.send({ sessionId, to: event.channelId, text: result.text });
    }
  }

  /**
   * Deliver an outbound `attachment` SSE event as a Discord file upload.
   * Bytes are pulled lazily from the agent-local API.
   */
  private async deliverAttachment(
    channelId: string,
    payload: Record<string, unknown>,
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
    await this.discord.sendFile(channelId, {
      bytes,
      filename: hintedName ?? filename ?? 'attachment',
      ...(caption ? { caption } : {}),
    });
  }

  private async ensureSession(
    sessionId: string,
    event: DiscordMessageEvent,
  ): Promise<void> {
    const metadata: Record<string, string> = {
      discord_channel_id: event.channelId,
      discord_user_id: event.userId,
      discord_username: event.username,
    };
    if (event.guildId) metadata.discord_guild_id = event.guildId;

    await this.client.openSession({
      sessionId,
      source: {
        kind: 'channel',
        interactive: true,
        platform: 'discord',
        type: event.isDm ? 'direct' : 'group',
      },
      metadata,
    });
  }

  private async waitForAgentResponse(
    sessionId: string,
    channelId: string,
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

    let sentMessageId: string | undefined;
    let lastEditTime = 0;
    const EDIT_THROTTLE_MS = 1500;

    const typingInterval = setInterval(() => {
      void this.discord.startTyping(channelId);
    }, 4_000);

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
            if (!sentMessageId && displayText.length > 0) {
              try {
                const sent = await this.discord.sendMessage(
                  channelId,
                  markdownToDiscord(displayText) + ' ...',
                );
                sentMessageId = sent.id;
                lastEditTime = now;
              } catch { /* will send final at end */ }
            } else if (sentMessageId && now - lastEditTime >= EDIT_THROTTLE_MS) {
              void this.discord.editMessage(
                channelId,
                sentMessageId,
                markdownToDiscord(displayText) + ' ...',
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
            error = String(payload.message ?? 'Unknown error');
            continue;
          }

          if (frame.event === 'attachment') {
            try {
              await this.deliverAttachment(channelId, payload);
            } catch (err) {
              this.log(
                `attachment delivery failed: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
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
      clearInterval(typingInterval);
      await reader.cancel().catch(() => undefined);
    }

    this.lastEventIds.set(sessionId, nextLastEventId);

    const rawResponseText = finalText ?? (accumulatedText.trim() || undefined);
    const stripped =
      rawResponseText !== undefined ? stripSilenceTokens(rawResponseText) : undefined;

    if (stripped?.isSilent) {
      if (sentMessageId) {
        void this.discord.deleteMessage(channelId, sentMessageId).catch(() => undefined);
      }
      return { text: undefined, error: undefined };
    }

    const responseText = stripped?.hadToken ? stripped.text : rawResponseText;

    if (sentMessageId && responseText) {
      try {
        await this.discord.editMessage(channelId, sentMessageId, markdownToDiscord(responseText));
      } catch {
        void this.discord.editMessage(channelId, sentMessageId, responseText).catch(() => undefined);
      }
    }

    return {
      text: sentMessageId ? undefined : responseText,
      error,
    };
  }
}
