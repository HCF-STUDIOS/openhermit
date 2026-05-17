/**
 * Channel plugin manifest for Telegram. Consumed by the gateway's
 * ChannelManifestRegistry; see `docs/channel-plugin-design.md`.
 */
import type { ChannelManifest } from '@openhermit/protocol';

import { TelegramApi } from './telegram-api.js';
import { TelegramBridge } from './bridge.js';
import { TelegramBot } from './bot.js';

interface TelegramRuntimeConfig {
  enabled?: boolean;
  bot_token: string;
  mode?: 'polling' | 'webhook';
  webhook_url?: string;
}

const manifest: ChannelManifest = {
  manifestVersion: 1,
  key: 'telegram',
  namespace: 'telegram',
  displayName: 'Telegram',
  start: async (rawConfig, context) => {
    const config = rawConfig as TelegramRuntimeConfig;
    const log = (msg: string): void => context.logger('telegram', msg);

    const api = new TelegramApi(config.bot_token);
    const bridge = new TelegramBridge(
      api,
      {
        baseUrl: context.agentBaseUrl,
        token: context.agentTokens['telegram'] ?? '',
      },
      log,
    );

    const mode = config.mode ?? 'polling';
    const botOptions: ConstructorParameters<typeof TelegramBot>[0] = {
      botToken: config.bot_token,
      bridge,
      mode,
      logger: log,
    };
    if (mode === 'webhook') {
      let derivedUrl: string;
      if (config.webhook_url) {
        derivedUrl = config.webhook_url;
      } else if (context.publicAgentBaseUrl === context.agentBaseUrl) {
        throw new Error(
          'Telegram webhook mode needs a public URL. Either set OPENHERMIT_GATEWAY_PUBLIC_URL on the gateway or provide webhook_url in the channel config.',
        );
      } else {
        derivedUrl = `${context.publicAgentBaseUrl}/channels/telegram/webhook`;
      }
      botOptions.webhookUrl = derivedUrl;
      const secret = context.agentTokens['telegram'];
      if (secret) botOptions.webhookSecret = secret;
    }

    const bot = new TelegramBot(botOptions);
    await bot.start();

    return {
      name: 'telegram',
      outbound: bridge,
      stop: () => bot.stop(),
      ...(mode === 'webhook'
        ? { handleWebhook: (req) => bot.handleWebhookRequest(req) }
        : {}),
    };
  },
};

export default manifest;
