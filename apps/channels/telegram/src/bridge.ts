/**
 * Bridge between Telegram messages and the OpenHermit agent API.
 * Translates Telegram updates into agent session interactions.
 */

import { randomUUID } from 'node:crypto';

import { AgentLocalClient, parseSseFrames } from '@openhermit/sdk';
import type { ChannelMessageAction, ChannelOutbound, ChannelOutboundResult } from '@openhermit/protocol';
import { stripSilenceTokens } from '@openhermit/shared';

import type { TelegramApi, TelegramCallbackQuery, TelegramMessage, TelegramMessageEntity, TelegramUser } from './telegram-api.js';
import {
  formatAgentResponse,
  markdownToTelegramHtml,
  streamingMarkdownToTelegramHtml,
} from './formatting.js';

/** Hard cap on TTS input length. Above this, fall back to text. */
const VOICE_MAX_TEXT_LENGTH = 1500;

/** Telegram Bot API can't download files larger than ~20 MB; skip those. */
const MAX_TELEGRAM_DOWNLOAD_BYTES = 20 * 1024 * 1024;

/** A downloadable inbound media file resolved from a Telegram message. */
export interface TelegramMediaFile {
  fileId: string;
  filename: string;
  mimeType: string;
  fileSize?: number;
}

/**
 * Pick the single downloadable media file off an inbound message (Telegram
 * sends at most one of photo/document/video per message). Photos arrive as an
 * array of sizes ascending; the last entry is the largest.
 */
export function pickMediaFile(message: TelegramMessage): TelegramMediaFile | undefined {
  if (message.photo && message.photo.length > 0) {
    const largest = message.photo[message.photo.length - 1]!;
    return {
      fileId: largest.file_id,
      filename: 'photo.jpg',
      mimeType: 'image/jpeg',
      ...(largest.file_size ? { fileSize: largest.file_size } : {}),
    };
  }
  if (message.document) {
    const d = message.document;
    return {
      fileId: d.file_id,
      filename: d.file_name ?? 'document',
      mimeType: d.mime_type ?? 'application/octet-stream',
      ...(d.file_size ? { fileSize: d.file_size } : {}),
    };
  }
  if (message.video) {
    const v = message.video;
    return {
      fileId: v.file_id,
      filename: v.file_name ?? 'video.mp4',
      mimeType: v.mime_type ?? 'video/mp4',
      ...(v.file_size ? { fileSize: v.file_size } : {}),
    };
  }
  return undefined;
}

/**
 * Decide whether a reply is fit for voice delivery. We refuse anything
 * containing code blocks, command-style markup, or huge volumes of
 * text — those are awkward to listen to and consume API quota for no
 * reader benefit.
 */
const shouldSpeak = (text: string): boolean => {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  if (trimmed.length > VOICE_MAX_TEXT_LENGTH) return false;
  if (trimmed.includes('```')) return false;
  return true;
};

/** Collected result of an agent turn. */
interface TurnResult {
  text: string | undefined;
  error: string | undefined;
}

export class TelegramBridge implements ChannelOutbound {
  readonly channel = 'telegram';

  private readonly client: AgentLocalClient;
  private readonly clientToken: string;
  private readonly log: (message: string) => void;
  /** Tracks last event ID per session for SSE deduplication. */
  private readonly lastEventIds = new Map<string, number>();
  /** Current sessionId per chat. */
  private readonly chatSessions = new Map<number, string>();
  /** Bot user info, lazily fetched via getMe(). */
  private botInfo: TelegramUser | undefined;
  /** Maps short callback IDs to (sessionId, toolCallId) for real-time approval buttons. */
  private readonly pendingApprovals = new Map<string, { sessionId: string; toolCallId: string }>();
  private approvalSeq = 0;
  /** Per-chat message queue to serialize message handling (avoids duplicate SSE watchers). */
  private readonly chatLocks = new Map<number, Promise<void>>();

  constructor(
    private readonly telegram: TelegramApi,
    clientOptions: { baseUrl: string; token: string },
    logger?: (message: string) => void,
  ) {
    this.client = new AgentLocalClient(clientOptions);
    this.clientToken = clientOptions.token;
    this.log = logger ?? ((msg: string) => console.log(`[telegram-bridge] ${msg}`));
  }

  /** Lazily fetch and cache bot user info. */
  private async getBotInfo(): Promise<TelegramUser> {
    if (!this.botInfo) {
      this.botInfo = await this.telegram.getMe();
    }
    return this.botInfo;
  }

  /** Check whether a message mentions or replies to the bot. */
  private async isMentioned(message: TelegramMessage): Promise<boolean> {
    const bot = await this.getBotInfo();

    // Reply to the bot's message
    if (message.reply_to_message?.from?.id === bot.id) {
      return true;
    }

    // @mention in text or caption entities. Telegram puts caption mentions
    // (on photo/document/video messages) in `caption_entities`, with offsets
    // into `caption` rather than `text`.
    const botUsername = bot.username?.toLowerCase();
    const entitySets: Array<{ entities: TelegramMessageEntity[] | undefined; source: string | undefined }> = [
      { entities: message.entities, source: message.text },
      { entities: message.caption_entities, source: message.caption },
    ];
    for (const { entities, source } of entitySets) {
      if (!entities) continue;
      for (const entity of entities) {
        if (entity.type === 'mention' && source && botUsername) {
          const mentionText = source
            .slice(entity.offset, entity.offset + entity.length)
            .toLowerCase();
          if (mentionText === `@${botUsername}`) {
            return true;
          }
        }
        // text_mention: when user has no username, Telegram uses this with a user object
        if (entity.type === 'text_mention' && entity.user?.id === bot.id) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Send a message to a Telegram chat via the Bot API.
   * Implements `ChannelOutbound.send()`. The caller is responsible for
   * recording the assistant log entry in the target session (the tool does
   * this via the store; the bridge reply path already has the assistant
   * message recorded by the agent runtime).
   */
  async send(params: { sessionId: string; to: string; text: string; actions?: ChannelMessageAction[] }): Promise<ChannelOutboundResult> {
    const chatId = Number(params.to);
    if (Number.isNaN(chatId)) {
      return { success: false, error: `Invalid Telegram chat ID: ${params.to}` };
    }

    try {
      const replyMarkup = this.buildReplyMarkup(params.actions);
      const chunks = formatAgentResponse(params.text);
      let lastMessageId: number | undefined;
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i]!;
        const isLast = i === chunks.length - 1;
        const sent = await this.telegram.sendMessage(chatId, chunk.text, {
          parseMode: chunk.parseMode,
          ...(isLast && replyMarkup ? { replyMarkup } : {}),
        });
        lastMessageId = sent.message_id;
      }

      const result: ChannelOutboundResult = { success: true };
      if (lastMessageId !== undefined) result.messageId = String(lastMessageId);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`failed to send message to chat ${chatId}: ${message}`);
      return { success: false, error: message };
    }
  }

  private buildReplyMarkup(actions?: ChannelMessageAction[]): unknown | undefined {
    if (!actions || actions.length === 0) return undefined;

    const buttons: { text: string; callback_data: string }[] = [];
    for (const action of actions) {
      if (action.type === 'approval_review') {
        const sid = String(action.shortId);
        buttons.push(
          { text: '✅ Approve', callback_data: `aa:${sid}` },
          { text: '❌ Reject', callback_data: `ar:${sid}` },
        );
      }
    }

    if (buttons.length === 0) return undefined;
    return { inline_keyboard: [buttons] };
  }

  private static generateSessionId(): string {
    return `telegram:${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`;
  }

  /** Get or create the current sessionId for a chat. */
  private async getSessionId(chatId: number): Promise<string> {
    const cached = this.chatSessions.get(chatId);
    if (cached) return cached;

    // Try to recover the most recent session for this chat from the server.
    try {
      const sessions = await this.client.listSessions({
        channel: 'telegram',
        metadata: { telegram_chat_id: String(chatId) },
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

    const sessionId = TelegramBridge.generateSessionId();
    this.chatSessions.set(chatId, sessionId);
    return sessionId;
  }

  /** Handle an incoming Telegram message (serialized per chat). */
  async handleMessage(message: TelegramMessage): Promise<void> {
    const chatId = message.chat.id;
    const prev = this.chatLocks.get(chatId) ?? Promise.resolve();
    const current = prev.then(
      () => this.handleMessageInner(message),
      () => this.handleMessageInner(message),
    );
    this.chatLocks.set(chatId, current.catch(() => {}));
    await current;
  }

  private async handleMessageInner(message: TelegramMessage): Promise<void> {
    const chatId = message.chat.id;
    const isGroup = message.chat.type === 'group' || message.chat.type === 'supergroup';

    // Photos/documents/videos carry their text in `caption`, not `text`.
    let text = message.text?.trim() || message.caption?.trim();

    // Inbound voice / audio → transcribe via the agent's STT before
    // passing as a normal text message. We mark the request so the
    // outbound path can prefer voice replies when appropriate.
    let inboundWasVoice = false;
    if (!text && (message.voice || message.audio)) {
      try {
        text = await this.transcribeAttachment(message);
        inboundWasVoice = Boolean(text);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log(`stt failed for chat ${chatId}: ${msg}`);
        await this.telegram.sendMessage(
          chatId,
          `Voice transcription failed: ${msg}`,
        );
        return;
      }
    }

    const hasMedia = Boolean(message.photo?.length || message.document || message.video);

    if (!text && !hasMedia) {
      return;
    }

    if (text === '/start') {
      await this.handleStart(chatId, message, isGroup);
      return;
    }

    if (text === '/new') {
      await this.handleNew(chatId);
      return;
    }

    // Tell the agent that this turn was spoken, not typed. Without this
    // marker the LLM has no way to know the text came from STT and the
    // reply will be spoken — it may answer with code blocks, long lists,
    // or even try to call a TTS tool itself.
    const agentText = inboundWasVoice
      ? `[Voice message, transcribed. Your reply will be converted to speech, so respond in plain prose without code blocks, markdown formatting, or long lists.]\n\n${text}`
      : (text ?? '');

    const sessionId = await this.getSessionId(chatId);
    await this.sendToAgent(chatId, sessionId, agentText, message, isGroup, inboundWasVoice);
  }

  /**
   * Download an inbound media file and upload it as a session attachment.
   * Returns the attachment id-shape array (empty on skip/failure).
   */
  private async resolveMediaAttachment(
    message: TelegramMessage,
    sessionId: string,
  ): Promise<{ type: 'file'; id: string }[]> {
    const media = pickMediaFile(message);
    if (!media) return [];
    if (media.fileSize && media.fileSize > MAX_TELEGRAM_DOWNLOAD_BYTES) {
      this.log(`skipping oversized media ${media.filename} (${media.fileSize} bytes)`);
      return [];
    }
    try {
      const file = await this.telegram.getFile(media.fileId);
      if (!file.file_path) throw new Error('Telegram returned no file_path');
      const bytes = await this.telegram.downloadFile(file.file_path);
      const blob = new Blob([bytes as unknown as BlobPart], { type: media.mimeType });
      const uploaded = await this.client.uploadAttachment(sessionId, blob, media.filename);
      return [{ type: 'file', id: uploaded.id! }];
    } catch (err) {
      this.log(`media upload failed: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  private async transcribeAttachment(message: TelegramMessage): Promise<string> {
    const fileId = message.voice?.file_id ?? message.audio?.file_id;
    const mimeType = message.voice?.mime_type ?? message.audio?.mime_type ?? 'audio/ogg';
    if (!fileId) return '';
    const file = await this.telegram.getFile(fileId);
    if (!file.file_path) {
      throw new Error('Telegram returned no file_path for voice attachment');
    }
    const bytes = await this.telegram.downloadFile(file.file_path);
    const result = await this.client.transcribeAudio({ bytes, mimeType });
    return result.text.trim();
  }

  private async handleStart(
    chatId: number,
    message: TelegramMessage,
    isGroup: boolean,
  ): Promise<void> {
    const displayName =
      message.from?.first_name ?? message.from?.username ?? 'there';

    const sessionId = await this.getSessionId(chatId);
    await this.ensureSession(sessionId, message, isGroup);
    await this.telegram.sendMessage(
      chatId,
      `Hello ${displayName}! I'm ready. Send me a message to get started.\n\nUse /new to start a fresh conversation.`,
    );
  }

  private async handleNew(
    chatId: number,
  ): Promise<void> {
    const oldSessionId = await this.getSessionId(chatId);

    // Checkpoint the current session before starting a new one.
    try {
      await this.client.checkpointSession(oldSessionId, { reason: 'new_session' });
    } catch {
      // Session may not exist yet — that's fine.
    }
    this.lastEventIds.delete(oldSessionId);

    // Generate a fresh sessionId for this chat.
    const newSessionId = TelegramBridge.generateSessionId();
    this.chatSessions.set(chatId, newSessionId);

    await this.telegram.sendMessage(chatId, 'New conversation started.');
  }

  private async sendToAgent(
    chatId: number,
    sessionId: string,
    text: string,
    message: TelegramMessage,
    isGroup: boolean,
    inboundWasVoice = false,
  ): Promise<void> {
    const mentioned = isGroup ? await this.isMentioned(message) : true;

    await this.ensureSession(sessionId, message, isGroup);

    const displayName = message.from?.first_name || message.from?.username;
    const senderPayload = message.from
      ? {
          sender: {
            channel: 'telegram' as const,
            channelUserId: String(message.from.id),
            ...(displayName ? { displayName } : {}),
          },
        }
      : {};

    // Upload any inbound photo/document/video as a session attachment
    // (images become vision input automatically).
    const attachments = await this.resolveMediaAttachment(message, sessionId);

    // Media-only message whose upload failed: nothing usable to forward.
    if (!text && attachments.length === 0) return;

    const postResult = await this.client.postMessage(sessionId, {
      text,
      mentioned,
      ...(attachments.length > 0 ? { attachments } : {}),
      ...senderPayload,
    });

    if (!(postResult as any).triggered) return;

    void this.telegram.sendChatAction(chatId).catch(() => undefined);

    const result = await this.waitForAgentResponse(sessionId, chatId, inboundWasVoice);

    if (result.error && !result.text) {
      await this.telegram.sendMessage(chatId, `Error: ${result.error}`);
    } else if (result.text) {
      if (inboundWasVoice) {
        const sent = await this.trySendVoiceReply(chatId, result.text);
        if (!sent) {
          await this.send({ sessionId, to: String(chatId), text: result.text });
        }
      } else {
        await this.send({ sessionId, to: String(chatId), text: result.text });
      }
    }
  }

  /**
   * Attempt to deliver `text` as a Telegram voice message via the
   * agent's configured TTS. Returns `true` on success, `false` when TTS
   * is unavailable or the text fails the speakable-content gate; callers
   * fall back to plain text on `false`.
   */
  private async trySendVoiceReply(chatId: number, text: string): Promise<boolean> {
    if (!shouldSpeak(text)) return false;
    try {
      const result = await this.client.synthesizeAudio({
        text,
        outputMimeType: 'audio/ogg',
      });
      await this.telegram.sendVoice(chatId, result.bytes);
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log(`tts failed for chat ${chatId}: ${msg}`);
      return false;
    }
  }

  /**
   * Translate an `attachment` SSE event into the right Telegram Bot API
   * upload. We let the rendering hint pick the endpoint (image → sendPhoto,
   * audio → sendAudio, video → sendVideo, document → sendDocument); the bytes
   * are pulled lazily from the agent-local API so we never inline them on the
   * SSE channel.
   */
  private async deliverAttachmentToTelegram(
    chatId: number,
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
    const hintedKind = String(payload.kind ?? '');
    const filename =
      typeof payload.name === 'string' && payload.name.length > 0
        ? payload.name
        : 'attachment';

    const { bytes, mimeType, kind: resolvedKind } =
      await this.client.downloadAttachmentBytes(sessionId, attachmentId);
    const kind = (hintedKind || resolvedKind || 'document') as
      | 'image'
      | 'audio'
      | 'video'
      | 'document';
    const opts = caption ? { caption } : undefined;

    if (kind === 'image') {
      await this.telegram.sendPhoto(chatId, bytes, filename, mimeType, opts);
      return;
    }
    if (kind === 'audio') {
      // ogg/opus → use sendVoice for the native voice-message bubble; other
      // audio formats stay as a regular audio attachment.
      if (mimeType === 'audio/ogg' || mimeType === 'audio/opus') {
        await this.telegram.sendVoice(chatId, bytes, opts);
        return;
      }
      await this.telegram.sendAudio(chatId, bytes, filename, mimeType, opts);
      return;
    }
    if (kind === 'video') {
      await this.telegram.sendVideo(chatId, bytes, filename, mimeType, opts);
      return;
    }
    await this.telegram.sendDocument(chatId, bytes, filename, mimeType, opts);
  }

  private async ensureSession(
    sessionId: string,
    message?: TelegramMessage,
    isGroup = false,
  ): Promise<void> {
    const metadata: Record<string, string | number> = {};

    if (message) {
      metadata.telegram_chat_id = message.chat.id;

      if (isGroup) {
        // Group sessions: include chat title, not individual sender info
        if (message.chat.title) {
          metadata.telegram_chat_title = message.chat.title;
        }
      } else {
        // Direct sessions: include sender info for session-level identity resolution
        if (message.from?.id) {
          metadata.telegram_user_id = message.from.id;
        }
        if (message.from?.username) {
          metadata.telegram_username = message.from.username;
        }
        if (message.from?.first_name) {
          metadata.telegram_first_name = message.from.first_name;
        }
      }
    }

    await this.client.openSession({
      sessionId,
      source: {
        kind: 'channel',
        interactive: true,
        platform: 'telegram',
        type: isGroup ? 'group' : 'direct',
      },
      ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    });
  }

  /**
   * Open the SSE event stream and collect the agent's response for one turn.
   * Supports streaming edits: sends an initial message on first text_delta,
   * then periodically edits it as more text arrives.
   */
  private async waitForAgentResponse(
    sessionId: string,
    chatId: number,
    suppressStreamingDisplay = false,
  ): Promise<TurnResult> {
    const eventsUrl = this.client.buildEventsUrl(sessionId);
    const lastEventId = this.lastEventIds.get(sessionId) ?? 0;

    const response = await fetch(eventsUrl, {
      headers: { authorization: `Bearer ${this.clientToken}` },
    });

    if (!response.ok || !response.body) {
      return {
        text: undefined,
        error: `Failed to open event stream (${response.status})`,
      };
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let nextLastEventId = lastEventId;
    let sequenceResetChecked = false;
    let accumulatedText = '';
    let finalText: string | undefined;
    let error: string | undefined;

    // Streaming edit state.
    let sentMessageId: number | undefined;
    let lastEditTime = 0;
    const EDIT_THROTTLE_MS = 1500;

    // Keep typing indicator alive.
    const typingInterval = setInterval(() => {
      void this.telegram.sendChatAction(chatId).catch(() => undefined);
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
          if (frame.id !== undefined && frame.id <= nextLastEventId) {
            continue;
          }
          if (frame.id !== undefined) {
            nextLastEventId = frame.id;
          }

          if (frame.event === 'ready') {
            // Detect sequence reset: a new runner restarts ids at 1, so
            // a stored cursor from a previous runner would skip every
            // event. Reset the cursor when the server's next id is
            // behind ours.
            if (!sequenceResetChecked) {
              sequenceResetChecked = true;
              try {
                const data = frame.data.length > 0
                  ? (JSON.parse(frame.data) as { nextEventId?: number })
                  : {};
                if (typeof data.nextEventId === 'number' && data.nextEventId <= nextLastEventId) {
                  nextLastEventId = 0;
                }
              } catch { /* ignore — fall back to stored cursor */ }
            }
            continue;
          }
          if (frame.event === 'ping') {
            continue;
          }

          const payload =
            frame.data.length > 0
              ? (JSON.parse(frame.data) as Record<string, unknown>)
              : {};

          if (frame.event === 'text_delta') {
            accumulatedText += String(payload.text ?? '');
            // Strip mid-stream too so a token can't flash before the final edit.
            const displayText = stripSilenceTokens(accumulatedText).text;

            // For voice replies we collect text silently — sending
            // streamed text would race against the voice message we're
            // about to upload, leaving two assistant messages in the
            // chat.
            if (suppressStreamingDisplay) continue;

            // Streaming edit: send initial message or throttled edits.
            const now = Date.now();
            if (!sentMessageId && displayText.length > 0) {
              try {
                const html = streamingMarkdownToTelegramHtml(displayText);
                const sent = await this.telegram.sendMessage(
                  chatId,
                  html + ' ...',
                  { parseMode: 'HTML' },
                );
                sentMessageId = sent.message_id;
                lastEditTime = now;
              } catch {
                // If send fails, we'll send the final text at the end.
              }
            } else if (
              sentMessageId &&
              now - lastEditTime >= EDIT_THROTTLE_MS
            ) {
              const html = streamingMarkdownToTelegramHtml(displayText);
              void this.telegram
                .editMessageText(chatId, sentMessageId, html + ' ...', { parseMode: 'HTML' })
                .catch(() => undefined);
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

          if (frame.event === 'approval_requested' && payload.mode === 'realtime') {
            const toolName = String(payload.resourceKey ?? 'unknown');
            const toolCallId = String(payload.toolCallId ?? '');
            const args = payload.args as Record<string, unknown> | undefined;
            void this.sendApprovalPrompt(chatId, sessionId, toolName, toolCallId, args).catch(() => undefined);
            continue;
          }

          if (frame.event === 'attachment') {
            try {
              await this.deliverAttachmentToTelegram(chatId, payload);
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

          // tool_call, tool_result — skip for now.
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

    // Agent chose not to reply (group chat, not mentioned).
    if (stripped?.isSilent) {
      if (sentMessageId) {
        // Delete the partially-streamed message.
        void this.telegram.deleteMessage(chatId, sentMessageId).catch(() => undefined);
      }
      return { text: undefined, error: undefined };
    }

    const responseText = stripped?.hadToken ? stripped.text : rawResponseText;

    // Final edit to show complete text with HTML formatting (remove trailing " ...").
    if (sentMessageId && responseText) {
      try {
        const html = markdownToTelegramHtml(responseText);
        await this.telegram.editMessageText(chatId, sentMessageId, html, { parseMode: 'HTML' });
      } catch {
        // HTML parse failed — fall back to plain text.
        void this.telegram
          .editMessageText(chatId, sentMessageId, responseText)
          .catch(() => undefined);
      }
    }

    return {
      text: sentMessageId ? undefined : responseText, // If we already streamed, don't send again.
      error,
    };
  }

  private async sendApprovalPrompt(
    chatId: number,
    sessionId: string,
    toolName: string,
    toolCallId: string,
    args?: Record<string, unknown>,
  ): Promise<void> {
    const id = String(++this.approvalSeq);
    this.pendingApprovals.set(id, { sessionId, toolCallId });

    let text = `🔔 <b>Approval Required</b>\n\nTool: <code>${this.escapeHtml(toolName)}</code>`;
    if (args && typeof args === 'object') {
      const entries = Object.entries(args);
      if (entries.length > 0) {
        const lines = entries.map(([k, v]) => {
          const val = typeof v === 'string' ? v : JSON.stringify(v, null, 2);
          const truncated = val.length > 300 ? val.slice(0, 300) + '…' : val;
          return `<b>${this.escapeHtml(k)}</b>: <code>${this.escapeHtml(truncated)}</code>`;
        });
        text += '\n\n' + lines.join('\n');
      }
    }

    await this.telegram.sendMessage(
      chatId,
      text,
      {
        parseMode: 'HTML',
        replyMarkup: {
          inline_keyboard: [[
            { text: '✅ Approve', callback_data: `a:${id}` },
            { text: '❌ Reject', callback_data: `r:${id}` },
          ]],
        },
      },
    );
  }

  async handleCallbackQuery(query: TelegramCallbackQuery): Promise<void> {
    const data = query.data;
    if (!data) return;

    const colonIdx = data.indexOf(':');
    if (colonIdx === -1) return;

    const prefix = data.slice(0, colonIdx);
    const id = data.slice(colonIdx + 1);

    if (prefix === 'a' || prefix === 'r') {
      await this.handleRealtimeApproval(query, id, prefix === 'a');
    } else if (prefix === 'aa' || prefix === 'ar') {
      await this.handleAsyncApproval(query, id, prefix === 'aa');
    }
  }

  private async handleRealtimeApproval(query: TelegramCallbackQuery, id: string, approved: boolean): Promise<void> {
    const pending = this.pendingApprovals.get(id);
    if (!pending) {
      await this.telegram.answerCallbackQuery(query.id, { text: 'This approval has expired.', showAlert: true });
      return;
    }

    this.pendingApprovals.delete(id);

    try {
      const approvalReq: Parameters<typeof this.client.submitApproval>[1] = {
        toolCallId: pending.toolCallId,
        approved,
      };
      if (query.from?.id) approvalReq.channelUserId = String(query.from.id);
      await this.client.submitApproval(pending.sessionId, approvalReq);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.log(`approval submission failed: ${msg}`);
      await this.telegram.answerCallbackQuery(query.id, { text: `Failed: ${msg}`, showAlert: true });
      return;
    }

    await this.telegram.answerCallbackQuery(query.id, { text: approved ? 'Approved' : 'Rejected' });
    this.editApprovalMessage(query, approved);
  }

  private async handleAsyncApproval(query: TelegramCallbackQuery, id: string, approved: boolean): Promise<void> {
    const shortId = Number.parseInt(id, 10);
    if (!Number.isFinite(shortId)) {
      await this.telegram.answerCallbackQuery(query.id, { text: 'Invalid approval id.', showAlert: true });
      return;
    }

    try {
      const reviewInput: Parameters<typeof this.client.reviewApprovalRequestByShortId>[1] = {
        decision: approved ? 'approved' : 'rejected',
        resolution: 'once',
      };
      if (query.from?.id) reviewInput.channelUserId = String(query.from.id);
      await this.client.reviewApprovalRequestByShortId(shortId, reviewInput);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.log(`async approval review failed: ${msg}`);
      await this.telegram.answerCallbackQuery(query.id, { text: `Failed: ${msg}`, showAlert: true });
      return;
    }

    await this.telegram.answerCallbackQuery(query.id, { text: approved ? 'Approved' : 'Rejected' });
    this.editApprovalMessage(query, approved);
  }

  private escapeHtml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  private editApprovalMessage(query: TelegramCallbackQuery, approved: boolean): void {
    if (!query.message) return;
    const label = approved ? '✅ Approved' : '❌ Rejected';
    const chatId = query.message.chat.id;
    const messageId = query.message.message_id;
    const originalText = query.message.text ?? '';
    void this.telegram.editMessageText(chatId, messageId, `${originalText}\n\n${label}`).catch(() => undefined);
    void this.telegram.editMessageReplyMarkup(chatId, messageId).catch(() => undefined);
  }
}
