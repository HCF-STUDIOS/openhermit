import { pathToFileURL } from 'node:url';

import { loadEnv } from '@openhermit/shared';
import { DiscordApi } from './discord-api.js';
import { DiscordBridge } from './bridge.js';
import { DiscordBot } from './bot.js';
import { loadConfig } from './config.js';

const log = (message: string): void => {
  console.log(`[openhermit-channel-discord] ${message}`);
};

export const main = async (): Promise<void> => {
  await loadEnv();
  const config = await loadConfig();
  log(`agent: ${config.agentBaseUrl}`);

  const api = new DiscordApi(config.botToken);
  const bridge = new DiscordBridge(api, {
    baseUrl: config.agentBaseUrl,
    token: config.agentToken,
  }, log);

  const bot = new DiscordBot({
    botToken: config.botToken,
    discord: api,
    bridge,
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

export { DiscordApi } from './discord-api.js';
export { DiscordBridge } from './bridge.js';
export { DiscordBot } from './bot.js';
export type { DiscordAdapterConfig } from './config.js';
export type { ChannelOutbound, ChannelOutboundResult } from '@openhermit/protocol';

// Default export: ChannelManifest consumed by the gateway plugin registry.
export { default } from './manifest.js';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
