/**
 * Channel plugin manifest for Discord. Consumed by the gateway's
 * ChannelManifestRegistry; see `docs/channel-plugin-design.md`.
 */
import type { ChannelManifest } from '@openhermit/protocol';

import { DiscordApi } from './discord-api.js';
import { DiscordBridge } from './bridge.js';
import { DiscordBot } from './bot.js';

interface DiscordRuntimeConfig {
  enabled?: boolean;
  bot_token: string;
}

const manifest: ChannelManifest = {
  manifestVersion: 1,
  key: 'discord',
  namespace: 'discord',
  displayName: 'Discord',
  start: async (rawConfig, context) => {
    const config = rawConfig as DiscordRuntimeConfig;
    const log = (msg: string): void => context.logger('discord', msg);

    const api = new DiscordApi(config.bot_token);
    const bridge = new DiscordBridge(
      api,
      {
        baseUrl: context.agentBaseUrl,
        token: context.agentTokens['discord'] ?? '',
      },
      log,
    );

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
  },
};

export default manifest;
