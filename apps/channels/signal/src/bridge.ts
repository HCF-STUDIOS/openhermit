import { randomUUID } from 'node:crypto';

import { AgentLocalClient, parseSseFrames } from '@openhermit/sdk';
import type { ChannelOutbound, ChannelOutboundResult } from '@openhermit/protocol';

import type { SignalApi, SignalIncomingMessage } from './signal-api.js';
import { formatAgentResponse } from './formatting.js';

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
    if (!allowedGroupIds || allowedGroupIds.length === 0) return true;
    return allowedGroupIds.includes(msg.groupId);
  }
  if (!allowedSenders || allowedSenders.length === 0) return true;
  if (msg.sourceUuid && allowedSenders.includes(`uuid:${msg.sourceUuid}`)) return true;
  if (msg.sourceNumber && allowedSenders.includes(msg.sourceNumber)) return true;
  return false;
}

const NO_REPLY_TAG = '<NO_REPLY>';

interface TurnResult {
  text: string | undefined;
  error: string | undefined;
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

  async send(params: { sessionId: string; to: string; text: string }): Promise<ChannelOutboundResult> {
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
      this.log(`failed to send to ${params.to}: ${message}`);
      return { success: false, error: message };
    }
  }

  private async sendChunkToTarget(target: string, text: string): Promise<{ timestamp: number }> {
    if (target.startsWith('signal:group:')) {
      return this.signal.sendGroupMessage(target.slice('signal:group:'.length), text);
    }
    if (target.startsWith('signal:uuid:')) {
      return this.signal.sendDirectMessage(target.slice('signal:uuid:'.length), text);
    }
    if (target.startsWith('signal:')) {
      return this.signal.sendDirectMessage(target.slice('signal:'.length), text);
    }
    return this.signal.sendDirectMessage(target, text);
  }

  async handleIncoming(msg: SignalIncomingMessage): Promise<void> {
    if (!shouldAcceptSender(msg, this.allowedSenders, this.allowedGroupIds)) {
      this.log(`dropped message from disallowed sender (${msg.sourceUuid ?? msg.sourceNumber})`);
      return;
    }
    if (msg.isSelf) return;

    const key = conversationKey(msg);
    const sessionId = await this.getSessionId(key, msg);
    await this.ensureSession(sessionId, msg);

    const senderChannelUserId = msg.sourceUuid ?? msg.sourceNumber ?? 'unknown';
    const senderName = msg.sourceName;
    // Signal has no first-class mentions; group filtering is handled by allowedGroupIds.
    const postResult = await this.client.postMessage(sessionId, {
      text: msg.text,
      mentioned: true,
      sender: {
        channel: 'signal',
        channelUserId: senderChannelUserId,
        ...(senderName ? { displayName: senderName } : {}),
      },
    });

    if (!(postResult as { triggered?: boolean }).triggered) return;

    const result = await this.waitForAgentResponse(sessionId);
    if (result.error && !result.text) {
      await this.send({ sessionId, to: key, text: `Error: ${result.error}` });
    } else if (result.text) {
      await this.send({ sessionId, to: key, text: result.text });
    }
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
  ): Promise<void> {
    const metadata: Record<string, string> = {};
    if (msg.groupId) metadata.signal_group_id = msg.groupId;
    if (msg.sourceUuid) metadata.signal_source = `uuid:${msg.sourceUuid}`;
    else if (msg.sourceNumber) metadata.signal_source = msg.sourceNumber;
    if (msg.sourceNumber) metadata.signal_source_number = msg.sourceNumber;

    await this.client.openSession({
      sessionId,
      source: {
        kind: 'channel',
        interactive: true,
        platform: 'signal',
        type: msg.groupId ? 'group' : 'direct',
      },
      metadata,
    });
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
    const responseText = finalText ?? (accumulatedText.trim() || undefined);
    if (responseText?.trim() === NO_REPLY_TAG) {
      return { text: undefined, error };
    }
    return { text: responseText, error };
  }
}
