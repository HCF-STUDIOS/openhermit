import { AgentLocalClient, parseSseFrames } from '@openhermit/sdk';
import type {
  ChannelMessageAction,
  ChannelOutbound,
  ChannelOutboundResult,
} from '@openhermit/protocol';
import { stripSilenceTokens } from '@openhermit/shared';

import { formatAgentResponse } from './formatting.js';
import {
  conversationKey,
  generateSessionId,
  groupAllowed,
  isGroupJid,
  isNewCommand,
  jidToPhone,
  normalizeJid,
  senderAllowed,
  targetToJid,
} from './jid.js';
import type { WhatsAppApi } from './whatsapp-api.js';

const AGENT_RESPONSE_TIMEOUT_MS = 60_000;

export interface WhatsAppIncomingMessage {
  chatJid: string;
  senderJid: string;
  senderNumber?: string;
  senderName?: string;
  messageId?: string;
  text: string;
  isGroup: boolean;
  mentioned: boolean;
  commandText?: string;
}

export interface WhatsAppBridgeOptions {
  allowedSenders?: string[];
  allowedGroupJids?: string[];
}

interface TurnResult {
  text: string | undefined;
  error: string | undefined;
}

export function shouldAcceptMessage(
  event: WhatsAppIncomingMessage,
  options: WhatsAppBridgeOptions,
): boolean {
  if (event.isGroup) return groupAllowed(event.chatJid, options.allowedGroupJids);
  return senderAllowed(event.senderJid, options.allowedSenders);
}

export class WhatsAppBridge implements ChannelOutbound {
  readonly channel = 'whatsapp';

  private readonly client: AgentLocalClient;
  private readonly clientToken: string;
  private readonly log: (message: string) => void;
  private readonly lastEventIds = new Map<string, number>();
  private readonly chatSessions = new Map<string, string>();
  private readonly chatLocks = new Map<string, Promise<void>>();

  constructor(
    private readonly whatsapp: WhatsAppApi,
    clientOptions: { baseUrl: string; token: string },
    private readonly options: WhatsAppBridgeOptions = {},
    logger?: (message: string) => void,
  ) {
    this.client = new AgentLocalClient(clientOptions);
    this.clientToken = clientOptions.token;
    this.log = logger ?? ((msg) => console.log(`[whatsapp-bridge] ${msg}`));
  }

  async send(params: {
    sessionId: string;
    to: string;
    text: string;
    actions?: ChannelMessageAction[];
  }): Promise<ChannelOutboundResult> {
    void params.actions;
    try {
      const target = targetToJid(params.to);
      let lastMessageId: string | undefined;
      for (const chunk of formatAgentResponse(params.text)) {
        const sent = await this.whatsapp.sendText(target, chunk);
        if (sent.messageId) lastMessageId = sent.messageId;
      }
      const result: ChannelOutboundResult = { success: true };
      if (lastMessageId) result.messageId = lastMessageId;
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log(`failed to send WhatsApp message: ${message}`);
      return { success: false, error: message };
    }
  }

  async handleIncoming(event: WhatsAppIncomingMessage): Promise<void> {
    const key = conversationKey(event.chatJid);
    const previous = this.chatLocks.get(key) ?? Promise.resolve();
    const current = previous.then(
      () => this.handleIncomingInner(event),
      () => this.handleIncomingInner(event),
    );
    const queued = current.catch(() => undefined);
    this.chatLocks.set(key, queued);
    try {
      await current;
    } finally {
      if (this.chatLocks.get(key) === queued) this.chatLocks.delete(key);
    }
  }

  private async handleIncomingInner(event: WhatsAppIncomingMessage): Promise<void> {
    if (!shouldAcceptMessage(event, this.options)) {
      this.log(`dropped message from disallowed WhatsApp chat ${event.chatJid}`);
      return;
    }

    const commandText = event.commandText ?? event.text;
    if ((!event.isGroup || event.mentioned) && isNewCommand(commandText)) {
      await this.handleNewSession(event.chatJid);
      return;
    }

    const sessionId = await this.getSessionId(event.chatJid);
    await this.ensureSession(sessionId, event);

    const senderChannelUserId = event.senderNumber ?? event.senderJid;
    const postOpts = event.isGroup ? undefined : { channelUserId: senderChannelUserId };
    const postResult = await this.client.postMessage(sessionId, {
      text: event.text,
      mentioned: event.mentioned,
      sender: {
        channel: 'whatsapp',
        channelUserId: senderChannelUserId,
        ...(event.senderName ? { displayName: event.senderName } : {}),
      },
      metadata: {
        whatsapp_chat_jid: event.chatJid,
        whatsapp_sender_jid: event.senderJid,
        ...(event.senderNumber ? { whatsapp_sender_number: event.senderNumber } : {}),
      },
    }, postOpts);

    if (!(postResult as { triggered?: boolean }).triggered) return;

    const result = await this.waitForAgentResponse(sessionId);
    if (result.error && !result.text) {
      await this.send({ sessionId, to: event.chatJid, text: `Error: ${result.error}` });
    } else if (result.text) {
      await this.send({ sessionId, to: event.chatJid, text: result.text });
    }
  }

  async handleNewSession(chatJid: string): Promise<void> {
    const normalizedChatJid = normalizeJid(chatJid);
    const oldSessionId = await this.getSessionId(normalizedChatJid);
    try {
      await this.client.checkpointSession(oldSessionId, { reason: 'new_session' });
    } catch {
      // Session may not exist yet.
    }
    this.lastEventIds.delete(oldSessionId);
    const newSessionId = generateSessionId(isGroupJid(normalizedChatJid));
    this.chatSessions.set(normalizedChatJid, newSessionId);
    await this.whatsapp.sendText(normalizedChatJid, 'New conversation started.');
  }

  private async getSessionId(chatJid: string): Promise<string> {
    const normalizedChatJid = normalizeJid(chatJid);
    const cached = this.chatSessions.get(normalizedChatJid);
    if (cached) return cached;

    try {
      const sessions = await this.client.listSessions({
        channel: 'whatsapp',
        metadata: { whatsapp_chat_jid: normalizedChatJid },
        limit: 1,
      });
      if (sessions.length > 0) {
        const sessionId = sessions[0]!.sessionId;
        this.chatSessions.set(normalizedChatJid, sessionId);
        return sessionId;
      }
    } catch {
      // Server unavailable; fall through to a new session id.
    }

    const sessionId = generateSessionId(isGroupJid(normalizedChatJid));
    this.chatSessions.set(normalizedChatJid, sessionId);
    return sessionId;
  }

  private async ensureSession(
    sessionId: string,
    event: WhatsAppIncomingMessage,
  ): Promise<void> {
    const metadata: Record<string, string> = {
      whatsapp_chat_jid: event.chatJid,
      whatsapp_sender_jid: event.senderJid,
    };
    const senderNumber = event.senderNumber ?? jidToPhone(event.senderJid);
    if (senderNumber) metadata.whatsapp_sender_number = senderNumber;
    if (event.isGroup) metadata.whatsapp_group_jid = event.chatJid;

    const senderChannelUserId = senderNumber ?? event.senderJid;
    const openOpts = event.isGroup ? undefined : { channelUserId: senderChannelUserId };
    await this.client.openSession({
      sessionId,
      source: {
        kind: 'channel',
        interactive: true,
        platform: 'whatsapp',
        type: event.isGroup ? 'group' : 'direct',
      },
      metadata,
    }, openOpts);
  }

  private async waitForAgentResponse(sessionId: string): Promise<TurnResult> {
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
              } catch {
                // ignore
              }
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
