/**
 * Channel plugin manifest for Signal (signal-cli-rest-api).
 *
 * Loaded by the gateway when `@openhermit/channel-signal` is listed under
 * `channelPackages` in gateway config. See `docs/channel-plugin-design.md`.
 */
import type { ChannelManifest } from '@openhermit/protocol';

import { SignalApi } from './signal-api.js';
import { SignalBridge } from './bridge.js';
import { SignalBot } from './bot.js';
import { createSignalSetup } from './setup.js';

interface SignalRuntimeConfig {
  enabled?: boolean;
  /** Base URL of the signal-cli-rest-api container, e.g. http://signal:8080. */
  http_url: string;
  /** E.164 phone number of the bot's Signal account. */
  account: string;
  allowed_senders?: string[];
  allowed_group_ids?: string[];
}

const manifest: ChannelManifest = {
  manifestVersion: 1,
  key: 'signal',
  namespace: 'signal',
  displayName: 'Signal',

  start: async (rawConfig, context) => {
    const config = rawConfig as SignalRuntimeConfig;
    const log = (msg: string): void => context.logger('signal', msg);
    const httpUrl = config.http_url?.trim() ?? '';
    const account = config.account?.trim() ?? '';

    if (!httpUrl || !account) {
      log('missing http_url or account — channel disabled until linked via setup');
      return undefined;
    }

    const api = new SignalApi({
      httpUrl,
      account,
    });

    const bridgeOptions: { allowedSenders?: string[]; allowedGroupIds?: string[] } = {};
    if (config.allowed_senders) bridgeOptions.allowedSenders = config.allowed_senders;
    if (config.allowed_group_ids) bridgeOptions.allowedGroupIds = config.allowed_group_ids;

    const bridge = new SignalBridge(
      api,
      {
        baseUrl: context.agentBaseUrl,
        token: context.agentTokens['signal'] ?? '',
      },
      bridgeOptions,
      log,
    );

    const bot = new SignalBot({ signal: api, bridge, logger: log });
    await bot.start();

    return {
      name: 'signal',
      outbound: bridge,
      stop: () => bot.stop(),
    };
  },

  setup: createSignalSetup(),
};

export default manifest;
