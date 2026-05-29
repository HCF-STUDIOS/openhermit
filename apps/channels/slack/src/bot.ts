import { SocketModeClient } from '@slack/socket-mode';

import type { SlackApi, SlackMessageEvent } from './slack-api.js';
import type { SlackBridge } from './bridge.js';

export interface BotOptions {
  appToken: string;
  slack: SlackApi;
  bridge: SlackBridge;
  logger?: (message: string) => void;
}

/**
 * Whether an inbound Slack event should be forwarded to the agent. Accepts
 * plain messages and `file_share` (attachments); drops other subtypes, bot
 * echoes, userless events, and empty messages with no files.
 */
export function isProcessableMessage(event: SlackMessageEvent): boolean {
  if (event.subtype && event.subtype !== 'file_share') return false;
  if (event.bot_id) return false;
  if (!event.user) return false;
  const hasFiles = Array.isArray(event.files) && event.files.length > 0;
  return Boolean(event.text?.trim()) || hasFiles;
}

export class SlackBot {
  private readonly socketMode: SocketModeClient;
  private readonly slack: SlackApi;
  private readonly bridge: SlackBridge;
  private readonly log: (message: string) => void;
  private botUserId: string | undefined;
  private readonly recentlyHandled = new Set<string>();

  constructor(private readonly options: BotOptions) {
    this.slack = options.slack;
    this.bridge = options.bridge;
    this.log = options.logger ?? ((msg: string) => console.log(`[slack-bot] ${msg}`));

    this.socketMode = new SocketModeClient({
      appToken: options.appToken,
    });
  }

  async start(): Promise<void> {
    const botInfo = await this.slack.getBotInfo();
    this.botUserId = botInfo.user_id;
    this.log(`connected as @${botInfo.name} (${botInfo.user_id})`);

    this.socketMode.on('message', async ({ event, ack }) => {
      await ack();
      await this.handleMessageEvent(event as SlackMessageEvent);
    });

    this.socketMode.on('app_mention', async ({ event, ack }) => {
      await ack();
      await this.handleMessageEvent(event as SlackMessageEvent);
    });

    await this.socketMode.start();
    this.log('socket mode started');
  }

  async stop(): Promise<void> {
    await this.socketMode.disconnect();
    this.log('bot stopped');
  }

  private async handleMessageEvent(event: SlackMessageEvent): Promise<void> {
    if (!isProcessableMessage(event)) return;

    // Deduplicate: Slack sends both `message` and `app_mention` for @mentions.
    const eventKey = event.ts;
    if (this.recentlyHandled.has(eventKey)) return;
    this.recentlyHandled.add(eventKey);
    setTimeout(() => this.recentlyHandled.delete(eventKey), 10_000);

    const isDm = event.channel_type === 'im';
    const isMentioned = isDm || this.isMentioned(event.text ?? '');
    const text = this.stripMention(event.text ?? '');

    if (isMentioned && (text === 'new' || text === '/new')) {
      try {
        await this.bridge.handleNewSession(event.channel, event.thread_ts);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        this.log(`error handling /new: ${msg}`);
      }
      return;
    }

    try {
      await this.bridge.handleMessage({
        ...event,
        text,
        mentioned: isMentioned,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.log(`error handling message in ${event.channel}: ${msg}`);
      try {
        await this.slack.sendMessage(
          event.channel,
          'Sorry, something went wrong. Please try again.',
          ...(event.thread_ts ? [{ threadTs: event.thread_ts }] : []),
        );
      } catch { /* ignore */ }
    }
  }

  private isMentioned(text: string): boolean {
    if (!this.botUserId) return false;
    return text.includes(`<@${this.botUserId}>`);
  }

  private stripMention(text: string): string {
    if (!this.botUserId) return text;
    return text.replace(new RegExp(`<@${this.botUserId}>\\s*`, 'g'), '').trim();
  }
}
