/**
 * Channel plugin manifest for Slack. Consumed by the gateway's
 * ChannelManifestRegistry; see `docs/channel-plugin-design.md`.
 */
import type { ChannelManifest } from '@openhermit/protocol';

import { SlackApi } from './slack-api.js';
import { SlackBridge } from './bridge.js';
import { SlackBot } from './bot.js';

interface SlackRuntimeConfig {
  enabled?: boolean;
  bot_token: string;
  app_token: string;
}

const manifest: ChannelManifest = {
  manifestVersion: 1,
  key: 'slack',
  namespace: 'slack',
  displayName: 'Slack',
  start: async (rawConfig, context) => {
    const config = rawConfig as SlackRuntimeConfig;
    const log = (msg: string): void => context.logger('slack', msg);

    const api = new SlackApi(config.bot_token);
    const bridge = new SlackBridge(
      api,
      {
        baseUrl: context.agentBaseUrl,
        token: context.agentTokens['slack'] ?? '',
      },
      log,
    );

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
  },
};

export default manifest;
