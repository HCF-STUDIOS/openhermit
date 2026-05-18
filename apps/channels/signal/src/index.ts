import { pathToFileURL } from 'node:url';

import manifest from './manifest.js';
import { SignalApi } from './signal-api.js';
import { SignalBridge } from './bridge.js';
import { SignalBot } from './bot.js';
import { loadConfig } from './config.js';
import { redactId } from './redact.js';

const log = (message: string): void => {
  console.log(`[openhermit-channel-signal] ${message}`);
};

const loadEnvIfAvailable = async (): Promise<void> => {
  try {
    const mod = (await import('@openhermit/shared')) as { loadEnv?: () => Promise<unknown> };
    if (typeof mod.loadEnv === 'function') {
      await mod.loadEnv();
    }
  } catch {
    // Helpers not installed — expected for published consumers.
  }
};

export const main = async (): Promise<void> => {
  await loadEnvIfAvailable();
  const config = await loadConfig();
  log(`agent: ${config.agentBaseUrl}`);
  log(`signal-cli-rest-api: ${config.httpUrl}`);
  log(`account: ${redactId(config.account)}`);

  const api = new SignalApi({ httpUrl: config.httpUrl, account: config.account });

  const bridgeOptions: { allowedSenders?: string[]; allowedGroupIds?: string[] } = {};
  if (config.allowedSenders) bridgeOptions.allowedSenders = config.allowedSenders;
  if (config.allowedGroupIds) bridgeOptions.allowedGroupIds = config.allowedGroupIds;

  const bridge = new SignalBridge(
    api,
    { baseUrl: config.agentBaseUrl, token: config.agentToken },
    bridgeOptions,
    log,
  );

  const bot = new SignalBot({ signal: api, bridge, logger: log });

  const shutdown = async (): Promise<void> => {
    log('shutting down...');
    await bot.stop();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  await bot.start();
};

export default manifest;
export { manifest };
export { SignalApi } from './signal-api.js';
export { SignalBridge } from './bridge.js';
export { SignalBot } from './bot.js';
export type { SignalAdapterConfig } from './config.js';
export type { SignalIncomingMessage } from './signal-api.js';
export type { ChannelOutbound, ChannelOutboundResult } from '@openhermit/protocol';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
