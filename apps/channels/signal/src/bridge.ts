import { randomUUID } from 'node:crypto';

import { AgentLocalClient, parseSseFrames } from '@openhermit/sdk';
import type {
  ChannelMessageAction,
  ChannelOutbound,
  ChannelOutboundResult,
} from '@openhermit/protocol';
import { stripSilenceTokens } from '@openhermit/shared';

import type { SendOptions, SignalApi, SignalIncomingMessage } from './signal-api.js';
import { formatAgentResponse } from './formatting.js';
import { redactId, redactTarget } from './redact.js';

const AGENT_RESPONSE_TIMEOUT_MS = 60_000;

/** Gateway-enforced attachment cap (25 MiB). Skip oversized media early. */
const MAX_MEDIA_BYTES = 25 * 1024 * 1024;

export function buildSignalBase64AttachmentDataUri(
  mimeType: string,
  filename: string,
  bytes: Uint8Array,
): string {
  const safeFilename = encodeURIComponent(filename);
  const b64 = Buffer.from(bytes).toString('base64');
  return `data:${mimeType};filename=${safeFilename};base64,${b64}`;
}

export interface ConversationKeyInput {
  sourceUuid?: string;
  sourceNumber?: string;
  groupId?: string;
}

export function conversationKey(input: ConversationKeyInput): string {
  if (input.groupId) return `signal:group:${input.groupId}`;
  if (input.sourceUuid) return `signal:uuid:${input.sourceUuid}`;
  if (input.sourceNumber) return `signal:${input.sourceNumber}`;
  throw new Error('conversationKey requires at least one of groupId, sourceUuid, sourceNumber');
}

export function generateSessionId(): string {
  return `signal:${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`;
}

export function shouldAcceptSender(
  msg: ConversationKeyInput,
  allowedSenders: string[] | undefined,
  allowedGroupIds: string[] | undefined,
): boolean {
  if (msg.groupId) {
    // Default-deny groups: a bot added to a random group must NOT start
    // replying to everyone. Operator opts in by listing the groupId in
    // allowed_group_ids. (Matches README behavior.)
    if (!allowedGroupIds || allowedGroupIds.length === 0) return false;
    return allowedGroupIds.includes(msg.groupId);
  }
  if (!allowedSenders || allowedSenders.length === 0) return true;
  if (msg.sourceUuid && allowedSenders.includes(`uuid:${msg.sourceUuid}`)) return true;
  if (msg.sourceNumber && allowedSenders.includes(msg.sourceNumber)) return true;
  return false;
}

interface TurnResult {
  text: string | undefined;
  error: string | undefined;
}

/** Outcome of resolving an inbound message's attachments. */
interface ResolvedInbound {
  text: string;
  attachments?: { type: 'file'; id: string }[];
}

export interface SignalBridgeOptions {
  allowedSenders?: string[];
  allowedGroupIds?: string[];
}

export class SignalBridge implements ChannelOutbound {
  readonly channel = 'signal';

  private readonly client: AgentLocalClient;
  private readonly clientToken: string;
  private readonly log: (message: string) => void;
  private readonly lastEventIds = new Map<string, number>();
  private readonly conversationSessions = new Map<string, string>();
  private readonly allowedSenders: string[] | undefined;
  private readonly allowedGroupIds: string[] | undefined;

  constructor(
    private readonly signal: SignalApi,
    clientOptions: { baseUrl: string; token: string },
    options: SignalBridgeOptions = {},
    logger?: (message: string) => void,
  ) {
    this.client = new AgentLocalClient(clientOptions);
    this.clientToken = clientOptions.token;
    this.log = logger ?? ((msg) => console.log(`[signal-bridge] ${msg}`));
    this.allowedSenders = options.allowedSenders;
    this.allowedGroupIds = options.allowedGroupIds;
  }

  async send(params: {
    sessionId: string;
    to: string;
    text: string;
    actions?: ChannelMessageAction[];
  }): Promise<ChannelOutboundResult> {
    // Signal has no inline-button surface; actions are accepted for contract parity.
    void params.actions;
    try {
      const chunks = formatAgentResponse(params.text);
      let lastTimestamp: number | undefined;
      for (const chunk of chunks) {
        const result = await this.sendChunkToTarget(params.to, chunk);
        lastTimestamp = result.timestamp;
      }
      const out: ChannelOutboundResult = { success: true };
      if (lastTimestamp !== undefined) out.messageId = String(lastTimestamp);
      return out;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`failed to send to ${redactTarget(params.to)}: ${message}`);
      return { success: false, error: message };
    }
  }

  private async sendChunkToTarget(
    target: string,
    text: string,
    opts?: SendOptions,
  ): Promise<{ timestamp: number }> {
    if (target.startsWith('signal:group:')) {
      return this.signal.sendGroupMessage(target.slice('signal:group:'.length), text, opts);
    }
    if (target.startsWith('signal:uuid:')) {
      return this.signal.sendDirectMessage(target.slice('signal:uuid:'.length), text, opts);
    }
    if (target.startsWith('signal:')) {
      return this.signal.sendDirectMessage(target.slice('signal:'.length), text, opts);
    }
    return this.signal.sendDirectMessage(target, text, opts);
  }

  async handleIncoming(msg: SignalIncomingMessage): Promise<void> {
    if (!shouldAcceptSender(msg, this.allowedSenders, this.allowedGroupIds)) {
      this.log(`dropped message from disallowed sender (${redactId(msg.sourceUuid ?? msg.sourceNumber)})`);
      return;
    }
    if (msg.isSelf) return;

    const key = conversationKey(msg);
    const sessionId = await this.getSessionId(key, msg);
    const senderChannelUserId = msg.sourceUuid ?? msg.sourceNumber ?? 'unknown';
    await this.ensureSession(sessionId, msg, senderChannelUserId);

    // Resolve attachments: audio is transcribed via STT; other media is
    // uploaded as a durable session attachment (images become vision input).
    const resolved = await this.resolveInbound(sessionId, msg);
    if (!resolved.text && !resolved.attachments) return;

    const senderName = msg.sourceName;
    // For DMs the sender IS the session user — surface that identity to the
    // gateway via `x-channel-user-id` so tools like identity_link_request
    // see a populated `currentChannel` / `currentChannelUserId`. For groups
    // identity is per-message (the agent-runner derives it from the sender
    // body field on each turn), so we don't claim a session-level user.
    const postOpts = msg.groupId ? undefined : { channelUserId: senderChannelUserId };
    const postResult = await this.client.postMessage(sessionId, {
      text: resolved.text,
      mentioned: true,
      ...(resolved.attachments ? { attachments: resolved.attachments } : {}),
      sender: {
        channel: 'signal',
        channelUserId: senderChannelUserId,
        ...(senderName ? { displayName: senderName } : {}),
      },
    }, postOpts);

    if (!(postResult as { triggered?: boolean }).triggered) return;

    const result = await this.waitForAgentResponse(sessionId, key);
    if (result.error && !result.text) {
      await this.send({ sessionId, to: key, text: `Error: ${result.error}` });
    } else if (result.text) {
      await this.send({ sessionId, to: key, text: result.text });
    }
  }

  /**
   * Download each inbound Signal attachment and either transcribe it (audio)
   * or upload it as a durable session attachment (everything else).
   */
  private async resolveInbound(
    sessionId: string,
    msg: SignalIncomingMessage,
  ): Promise<ResolvedInbound> {
    let text = msg.text;
    const ids: { type: 'file'; id: string }[] = [];
    const transcripts: string[] = [];

    for (const att of msg.attachments ?? []) {
      if (att.size && att.size > MAX_MEDIA_BYTES) {
        this.log(`skipping oversized attachment ${redactId(att.id)} (${att.size} bytes)`);
        continue;
      }
      let bytes: Uint8Array;
      let contentType: string | undefined;
      try {
        const dl = await this.signal.downloadAttachment(att.id, MAX_MEDIA_BYTES);
        bytes = dl.bytes;
        contentType = dl.contentType;
      } catch (err) {
        this.log(`failed to download attachment ${redactId(att.id)}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      const mime = att.contentType ?? contentType ?? 'application/octet-stream';
      const filename = att.filename ?? `${att.id}.${mime.split(';', 1)[0]!.split('/')[1] ?? 'bin'}`;
      if (mime.startsWith('audio/')) {
        try {
          const { text: transcript } = await this.client.transcribeAudio({ bytes, mimeType: mime });
          if (transcript.trim()) transcripts.push(transcript.trim());
        } catch (err) {
          this.log(`stt failed for ${redactId(att.id)}: ${err instanceof Error ? err.message : String(err)}`);
        }
      } else {
        try {
          const blob = new Blob([bytes as unknown as BlobPart], { type: mime });
          const uploaded = await this.client.uploadAttachment(sessionId, blob, filename);
          ids.push({ type: 'file', id: uploaded.id! });
        } catch (err) {
          this.log(`upload failed for ${redactId(att.id)}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    if (transcripts.length > 0) {
      const joined = transcripts.join('\n\n');
      text = text ? `${text}\n\n[Transcribed voice message]\n${joined}` : `[Transcribed voice message]\n${joined}`;
    }

    return { text, ...(ids.length > 0 ? { attachments: ids } : {}) };
  }

  /**
   * Deliver an outbound `attachment` SSE event via signal-cli base64 send.
   * Bytes are pulled lazily from the agent-local API and base64-encoded.
   */
  private async deliverAttachment(
    target: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const sessionId = String(payload.sessionId ?? '');
    const attachmentId = String(payload.attachmentId ?? '');
    if (!sessionId || !attachmentId) {
      this.log('attachment event missing sessionId/attachmentId');
      return;
    }
    const caption =
      typeof payload.caption === 'string' && payload.caption.length > 0 ? payload.caption : '';
    const hintedName =
      typeof payload.name === 'string' && payload.name.length > 0 ? payload.name : undefined;

    const { bytes, mimeType, filename } = await this.client.downloadAttachmentBytes(sessionId, attachmentId);
    const name = hintedName ?? filename ?? 'attachment';
    const dataUri = buildSignalBase64AttachmentDataUri(mimeType, name, bytes);
    await this.sendChunkToTarget(target, caption, { base64Attachments: [dataUri] });
  }

  private async getSessionId(
    key: string,
    msg: SignalIncomingMessage,
  ): Promise<string> {
    const cached = this.conversationSessions.get(key);
    if (cached) return cached;

    try {
      const metadata: Record<string, string> = {};
      if (msg.groupId) metadata.signal_group_id = msg.groupId;
      else if (msg.sourceUuid) metadata.signal_source = `uuid:${msg.sourceUuid}`;
      else if (msg.sourceNumber) metadata.signal_source = msg.sourceNumber;

      const sessions = await this.client.listSessions({
        channel: 'signal',
        metadata,
        limit: 1,
      });
      if (sessions.length > 0) {
        const sessionId = sessions[0]!.sessionId;
        this.conversationSessions.set(key, sessionId);
        return sessionId;
      }
    } catch {
      /* ignore */
    }

    const id = generateSessionId();
    this.conversationSessions.set(key, id);
    return id;
  }

  private async ensureSession(
    sessionId: string,
    msg: SignalIncomingMessage,
    senderChannelUserId: string,
  ): Promise<void> {
    const metadata: Record<string, string> = {};
    if (msg.groupId) metadata.signal_group_id = msg.groupId;
    if (msg.sourceUuid) metadata.signal_source = `uuid:${msg.sourceUuid}`;
    else if (msg.sourceNumber) metadata.signal_source = msg.sourceNumber;
    if (msg.sourceNumber) metadata.signal_source_number = msg.sourceNumber;

    // DMs: pass the sender so the runtime sees a populated caller. Groups:
    // don't claim a session-level user (identity is per-message).
    const openOpts = msg.groupId ? undefined : { channelUserId: senderChannelUserId };
    await this.client.openSession({
      sessionId,
      source: {
        kind: 'channel',
        interactive: true,
        platform: 'signal',
        type: msg.groupId ? 'group' : 'direct',
      },
      metadata,
    }, openOpts);
  }

  private async waitForAgentResponse(sessionId: string, target: string): Promise<TurnResult> {
    const eventsUrl = this.client.buildEventsUrl(sessionId);
    const lastEventId = this.lastEventIds.get(sessionId) ?? 0;
    const controller = new AbortController();
    const timeoutTimer = setTimeout(() => controller.abort(), AGENT_RESPONSE_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(eventsUrl, {
        headers: { authorization: `Bearer ${this.clientToken}` },
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timeoutTimer);
      const message = err instanceof Error ? err.message : String(err);
      const reason = controller.signal.aborted
        ? `agent event stream timed out after ${AGENT_RESPONSE_TIMEOUT_MS}ms`
        : `Failed to open event stream (${message})`;
      return { text: undefined, error: reason };
    }
    if (!response.ok || !response.body) {
      clearTimeout(timeoutTimer);
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
            error = String(payload.message ?? 'Unknown error');
            continue;
          }
          if (frame.event === 'attachment') {
            try {
              await this.deliverAttachment(target, payload);
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
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (controller.signal.aborted && !error) {
        error = `agent event stream timed out after ${AGENT_RESPONSE_TIMEOUT_MS}ms`;
      } else if (!error) {
        error = message;
      }
    } finally {
      clearTimeout(timeoutTimer);
      await reader.cancel().catch(() => undefined);
    }

    this.lastEventIds.set(sessionId, nextLastEventId);
    const responseText = finalText ?? (accumulatedText.trim() || undefined);
    if (responseText === undefined) {
      return { text: undefined, error };
    }
    const stripped = stripSilenceTokens(responseText);
    if (stripped.isSilent) {
      return { text: undefined, error };
    }
    return { text: stripped.hadToken ? stripped.text : responseText, error };
  }
}
