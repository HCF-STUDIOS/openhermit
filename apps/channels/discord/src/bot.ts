import { ChannelType, Events, type Message } from 'discord.js';

import type { DiscordApi, DiscordIncomingAttachment, DiscordMessageEvent } from './discord-api.js';
import type { DiscordBridge } from './bridge.js';

export interface BotOptions {
  botToken: string;
  discord: DiscordApi;
  bridge: DiscordBridge;
  logger?: (message: string) => void;
}

export class DiscordBot {
  private readonly discord: DiscordApi;
  private readonly bridge: DiscordBridge;
  private readonly botToken: string;
  private readonly log: (message: string) => void;

  constructor(options: BotOptions) {
    this.discord = options.discord;
    this.bridge = options.bridge;
    this.botToken = options.botToken;
    this.log = options.logger ?? ((msg: string) => console.log(`[discord-bot] ${msg}`));
  }

  async start(): Promise<void> {
    this.discord.client.on(Events.MessageCreate, (message: Message) => {
      void this.handleMessage(message);
    });

    // discord.js v14 doesn't reliably emit MessageCreate for DMs even with
    // Partials.Channel — handle them via the raw gateway dispatch instead.
    this.discord.client.on('raw' as any, (packet: any) => {
      if (packet.t !== 'MESSAGE_CREATE') return;
      const { guild_id: guildId, author, content, channel_id: channelId, id: messageId, attachments } = packet.d ?? {};
      if (guildId || !author || author.bot) return;
      const mapped = mapRawAttachments(attachments);
      // Allow media-only DMs (no text) through when files are attached.
      if (!content && mapped.length === 0) return;

      const event: DiscordMessageEvent = {
        channelId,
        userId: author.id,
        username: author.username,
        displayName: author.global_name ?? author.username,
        text: content ?? '',
        messageId,
        isDm: true,
        mentioned: true,
        ...(mapped.length > 0 ? { attachments: mapped } : {}),
      };
      void this.bridge.handleMessage(event).catch((err: Error) => {
        this.log(`error handling DM: ${err.message}`);
      });
    });

    await this.discord.login(this.botToken);
    this.log(`connected as ${this.discord.botUsername} (${this.discord.botUserId})`);
  }

  async stop(): Promise<void> {
    await this.discord.destroy();
    this.log('bot stopped');
  }

  private async handleMessage(message: Message): Promise<void> {
    if (message.partial) {
      try {
        message = await message.fetch();
      } catch {
        return;
      }
    }
    if (message.author.bot) return;

    // DMs are handled via the raw gateway dispatch above.
    if (message.channel.type === ChannelType.DM) return;

    const mapped = mapMessageAttachments(message);
    // Allow media-only messages (no text) through when files are attached.
    if (!message.content && mapped.length === 0) return;

    const mentioned = this.isMentioned(message);
    const text = this.stripMention(message.content);

    if (mentioned && (text === 'new' || text === '/new')) {
      try {
        await this.bridge.handleNewSession(message.channelId);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        this.log(`error handling /new: ${msg}`);
      }
      return;
    }

    const event: DiscordMessageEvent = {
      channelId: message.channelId,
      userId: message.author.id,
      username: message.author.username,
      displayName: message.member?.displayName ?? message.author.displayName ?? message.author.username,
      text,
      messageId: message.id,
      isDm: false,
      mentioned,
      ...(message.guildId ? { guildId: message.guildId } : {}),
      ...(mapped.length > 0 ? { attachments: mapped } : {}),
    };

    try {
      await this.bridge.handleMessage(event);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.log(`error handling message in ${message.channelId}: ${msg}`);
      if (mentioned) {
        try {
          await message.reply('Sorry, something went wrong. Please try again.');
        } catch { /* ignore */ }
      }
    }
  }

  // (helpers below the class)

  private isMentioned(message: Message): boolean {
    const botId = this.discord.botUserId;
    if (!botId) return false;
    return message.mentions.users.has(botId);
  }

  private stripMention(text: string): string {
    const botId = this.discord.botUserId;
    if (!botId) return text;
    return text.replace(new RegExp(`<@!?${botId}>\\s*`, 'g'), '').trim();
  }
}

/** Map discord.js Message attachments to the channel-neutral shape. */
export function mapMessageAttachments(message: Message): DiscordIncomingAttachment[] {
  const out: DiscordIncomingAttachment[] = [];
  for (const att of message.attachments.values()) {
    out.push({
      url: att.url,
      name: att.name ?? 'attachment',
      ...(att.contentType ? { contentType: att.contentType } : {}),
      ...(typeof att.size === 'number' ? { size: att.size } : {}),
    });
  }
  return out;
}

/** Map raw gateway dispatch attachments (snake_case) to the neutral shape. */
export function mapRawAttachments(attachments: unknown): DiscordIncomingAttachment[] {
  if (!Array.isArray(attachments)) return [];
  const out: DiscordIncomingAttachment[] = [];
  for (const att of attachments) {
    if (!att || typeof att.url !== 'string') continue;
    out.push({
      url: att.url,
      name: typeof att.filename === 'string' ? att.filename : 'attachment',
      ...(typeof att.content_type === 'string' ? { contentType: att.content_type } : {}),
      ...(typeof att.size === 'number' ? { size: att.size } : {}),
    });
  }
  return out;
}
