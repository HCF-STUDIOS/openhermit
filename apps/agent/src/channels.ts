/**
 * Channel launcher — starts configured channel adapters after the agent API is ready.
 * Uses dynamic imports so the agent doesn't hard-depend on specific channel packages.
 */

import type {
  ChannelContext,
  ChannelHandle,
  ChannelOutbound,
  WebhookHandler,
  WebhookRequest,
  WebhookResponse,
} from '@openhermit/protocol';

import type { ChannelsConfig } from './core/types.js';

// Re-export the channel runtime types that used to live here. Consumers
// like `@openhermit/gateway` import them via `@openhermit/agent/channels`;
// the canonical definitions are now in `@openhermit/protocol` so that
// third-party channel plugins can depend on a stable contract.
export type {
  ChannelContext,
  ChannelHandle,
  ChannelOutbound,
  WebhookHandler,
  WebhookRequest,
  WebhookResponse,
};

export interface ChannelStatus {
  name: string;
  status: 'connected' | 'error';
  error?: string;
}

export interface StartChannelsResult {
  handles: ChannelHandle[];
  statuses: ChannelStatus[];
}

export const startChannels = async (
  channels: ChannelsConfig | undefined,
  context: ChannelContext,
): Promise<StartChannelsResult> => {
  if (!channels) return { handles: [], statuses: [] };

  const handles: ChannelHandle[] = [];
  const statuses: ChannelStatus[] = [];

  const tryStart = async (name: string, fn: () => Promise<ChannelHandle | undefined>): Promise<void> => {
    try {
      const handle = await fn();
      if (handle) {
        handles.push(handle);
        statuses.push({ name, status: 'connected' });
      } else {
        statuses.push({ name, status: 'error', error: 'Failed to start' });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      context.logger(name, `failed to start ${name} channel: ${msg}`);
      statuses.push({ name, status: 'error', error: msg });
    }
  };

  // Start all enabled channels in parallel — each is an independent network
  // connection (Telegram poll, Slack RTM, Discord WS) and they don't share
  // state, so serial startup just delays the slowest one.
  const tasks: Array<Promise<void>> = [];
  if (channels.telegram?.enabled) {
    tasks.push(tryStart('telegram', () => startTelegram(channels.telegram!, context)));
  }
  if (channels.slack?.enabled) {
    tasks.push(tryStart('slack', () => startSlack(channels.slack!, context)));
  }
  if (channels.discord?.enabled) {
    tasks.push(tryStart('discord', () => startDiscord(channels.discord!, context)));
  }
  await Promise.all(tasks);

  return { handles, statuses };
};

export const stopChannels = async (handles: ChannelHandle[]): Promise<void> => {
  for (const handle of handles) {
    try {
      await handle.stop();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[channels] error stopping ${handle.name}: ${message}`);
    }
  }
};

export interface SingleChannelResult {
  handle?: ChannelHandle;
  status: ChannelStatus;
}

const starters: Record<string, (config: ChannelsConfig, context: ChannelContext) => Promise<ChannelHandle | undefined>> = {
  telegram: (cfg, ctx) => startTelegram(cfg.telegram!, ctx),
  slack: (cfg, ctx) => startSlack(cfg.slack!, ctx),
  discord: (cfg, ctx) => startDiscord(cfg.discord!, ctx),
};

export const startSingleChannel = async (
  name: string,
  channels: ChannelsConfig,
  context: ChannelContext,
): Promise<SingleChannelResult> => {
  const starter = starters[name];
  if (!starter) {
    return { status: { name, status: 'error', error: `Unknown channel: ${name}` } };
  }
  try {
    const handle = await starter(channels, context);
    if (handle) {
      return { handle, status: { name, status: 'connected' } };
    }
    return { status: { name, status: 'error', error: 'Failed to start' } };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    context.logger(name, `failed to start ${name} channel: ${msg}`);
    return { status: { name, status: 'error', error: msg } };
  }
};

async function startDiscord(
  config: NonNullable<ChannelsConfig['discord']>,
  context: ChannelContext,
): Promise<ChannelHandle | undefined> {
  const log = (msg: string) => context.logger('discord', msg);

  try {
    const { DiscordApi, DiscordBridge, DiscordBot } = await import(
      '@openhermit/channel-discord'
    );

    const api = new DiscordApi(config.bot_token);
    const bridge = new DiscordBridge(api, {
      baseUrl: context.agentBaseUrl,
      token: context.agentTokens['discord'] ?? '',
    }, log);

    const bot = new DiscordBot({
      botToken: config.bot_token,
      discord: api,
      bridge,
      logger: log,
    });

    await bot.start();

    return {
      name: 'discord',
      outbound: bridge,
      stop: () => bot.stop(),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`failed to start discord channel: ${message}`);
    return undefined;
  }
}

async function startSlack(
  config: NonNullable<ChannelsConfig['slack']>,
  context: ChannelContext,
): Promise<ChannelHandle | undefined> {
  const log = (msg: string) => context.logger('slack', msg);

  try {
    const { SlackApi, SlackBridge, SlackBot } = await import(
      '@openhermit/channel-slack'
    );

    const api = new SlackApi(config.bot_token);
    const bridge = new SlackBridge(api, {
      baseUrl: context.agentBaseUrl,
      token: context.agentTokens['slack'] ?? '',
    }, log);

    const bot = new SlackBot({
      appToken: config.app_token,
      slack: api,
      bridge,
      logger: log,
    });

    await bot.start();

    return {
      name: 'slack',
      outbound: bridge,
      stop: () => bot.stop(),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`failed to start slack channel: ${message}`);
    return undefined;
  }
}

async function startTelegram(
  config: NonNullable<ChannelsConfig['telegram']>,
  context: ChannelContext,
): Promise<ChannelHandle | undefined> {
  const log = (msg: string) => context.logger('telegram', msg);

  try {
    const { TelegramApi, TelegramBridge, TelegramBot } = await import(
      '@openhermit/channel-telegram'
    );

    const api = new TelegramApi(config.bot_token);
    const bridge = new TelegramBridge(api, {
      baseUrl: context.agentBaseUrl,
      token: context.agentTokens['telegram'] ?? '',
    }, log);

    const mode = config.mode ?? 'polling';
    const botOptions: ConstructorParameters<typeof TelegramBot>[0] = {
      botToken: config.bot_token,
      bridge,
      mode,
      logger: log,
    };
    if (mode === 'webhook') {
      // Gateway-hosted webhook URL (single port, single TLS cert).
      const derivedUrl = config.webhook_url || `${context.agentBaseUrl}/channels/telegram/webhook`;
      botOptions.webhookUrl = derivedUrl;
      // Use the per-channel token as Telegram's secret_token; we verify
      // X-Telegram-Bot-Api-Secret-Token on each incoming request.
      const secret = context.agentTokens['telegram'];
      if (secret) botOptions.webhookSecret = secret;
    }

    const bot = new TelegramBot(botOptions);
    await bot.start();

    const handle: ChannelHandle = {
      name: 'telegram',
      outbound: bridge,
      stop: () => bot.stop(),
    };
    if (mode === 'webhook') {
      handle.handleWebhook = (req) => bot.handleWebhookRequest(req);
    }
    return handle;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`failed to start telegram channel: ${message}`);
    return undefined;
  }
}
