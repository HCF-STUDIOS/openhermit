import { randomUUID } from 'node:crypto';

import { AgentLocalClient, parseSseFrames } from '@openhermit/sdk';
import type { ChannelOutbound, ChannelOutboundResult } from '@openhermit/protocol';

import type { SlackApi, SlackMessageEvent } from './slack-api.js';
import { formatAgentResponse, markdownToSlackMrkdwn } from './formatting.js';

const NO_REPLY_TAG = '<NO_REPLY>';

interface TurnResult {
  text: string | undefined;
  error: string | undefined;
}

export class SlackBridge implements ChannelOutbound {
  readonly channel = 'slack';

  private readonly client: AgentLocalClient;
  private readonly clientToken: string;
  private readonly log: (message: string) => void;
  private readonly lastEventIds = new Map<string, number>();
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
    const text = event.text?.trim();

    if (!text || !event.user) return;

    const threadTs = event.thread_ts;
    const isDm = event.channel_type === 'im';
    const mentioned = event.mentioned ?? isDm;
    const sessionId = await this.getSessionId(channelId, threadTs);

    await this.sendToAgent(channelId, sessionId, text, event, isDm, mentioned, threadTs);
  }

  async handleNewSession(channelId: string, threadTs?: string): Promise<void> {
    const key = this.sessionKey(channelId, threadTs);
    const oldSessionId = this.channelSessions.get(key);

    if (oldSessionId) {
      try {
        await this.client.checkpointSession(oldSessionId, { reason: 'new_session' });
      } catch { /* ignore */ }
      this.lastEventIds.delete(oldSessionId);
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
    await this.ensureSession(sessionId, event, isDm, threadTs);

    let displayName: string | undefined;
    if (event.user) {
      try {
        const userInfo = await this.slack.getUserInfo(event.user);
        displayName = userInfo.real_name || userInfo.name;
      } catch { /* ignore */ }
    }

    const postResult = await this.client.postMessage(sessionId, {
      text,
      mentioned,
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

            const now = Date.now();
            if (!sentTs && accumulatedText.length > 0) {
              try {
                const sent = await this.slack.sendMessage(
                  channelId,
                  markdownToSlackMrkdwn(accumulatedText) + ' ...',
                  ...(threadTs ? [{ threadTs }] : []),
                );
                sentTs = sent.ts;
                lastEditTime = now;
              } catch { /* will send final at end */ }
            } else if (sentTs && now - lastEditTime >= EDIT_THROTTLE_MS) {
              void this.slack.updateMessage(
                channelId,
                sentTs,
                markdownToSlackMrkdwn(accumulatedText) + ' ...',
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
      if (sentTs) {
        void this.slack.web.chat.delete({ channel: channelId, ts: sentTs }).catch(() => undefined);
      }
      return { text: undefined, error: undefined };
    }

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
