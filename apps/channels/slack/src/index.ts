import { pathToFileURL } from 'node:url';

import { loadEnv } from '@openhermit/shared';
import { SlackApi } from './slack-api.js';
import { SlackBridge } from './bridge.js';
import { SlackBot } from './bot.js';
import { loadConfig } from './config.js';

const log = (message: string): void => {
  console.log(`[openhermit-channel-slack] ${message}`);
};

export const main = async (): Promise<void> => {
  await loadEnv();
  const config = await loadConfig();
  log(`agent: ${config.agentBaseUrl}`);

  const api = new SlackApi(config.botToken);
  const bridge = new SlackBridge(api, {
    baseUrl: config.agentBaseUrl,
    token: config.agentToken,
  }, log);

  const bot = new SlackBot({
    appToken: config.appToken,
    slack: api,
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

export { SlackApi } from './slack-api.js';
export { SlackBridge } from './bridge.js';
export { SlackBot } from './bot.js';
export type { SlackAdapterConfig } from './config.js';
export type { ChannelOutbound, ChannelOutboundResult } from '@openhermit/protocol';

// Default export: ChannelManifest consumed by the gateway plugin registry.
export { default } from './manifest.js';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
