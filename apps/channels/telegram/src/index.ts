import { pathToFileURL } from 'node:url';

import { loadEnv } from '@openhermit/shared';
import { TelegramApi } from './telegram-api.js';
import { TelegramBridge } from './bridge.js';
import { TelegramBot } from './bot.js';
import { loadConfig } from './config.js';

const log = (message: string): void => {
  console.log(`[openhermit-channel-telegram] ${message}`);
};

export const main = async (): Promise<void> => {
  await loadEnv();
  const config = await loadConfig();
  log(`mode: ${config.mode}`);
  log(`agent: ${config.agentBaseUrl}`);

  const api = new TelegramApi(config.botToken);
  const bridge = new TelegramBridge(api, {
    baseUrl: config.agentBaseUrl,
    token: config.agentToken,
  }, log);

  const bot = new TelegramBot({
    botToken: config.botToken,
    bridge,
    mode: config.mode,
    ...config.webhookUrl ? { webhookUrl: config.webhookUrl } : {},
    ...config.webhookPort ? { webhookPort: config.webhookPort } : {},
    ...config.pollingInterval ? { pollingInterval: config.pollingInterval } : {},
    logger: log,
  });

  const shutdown = async (): Promise<void> => {
    log('shutting down...');
    await bot.stop();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  await bot.start();
};

// Re-export for programmatic use.
export { TelegramApi } from './telegram-api.js';
export { TelegramBridge } from './bridge.js';
export { TelegramBot } from './bot.js';
export type { TelegramAdapterConfig } from './config.js';
export type { ChannelOutbound, ChannelOutboundResult } from '@openhermit/protocol';

// Default export: ChannelManifest consumed by the gateway plugin registry.
export { default } from './manifest.js';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
