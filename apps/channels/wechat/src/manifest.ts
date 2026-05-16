/**
 * Channel plugin manifest for WeChat (iLink protocol).
 *
 * v0 scope: text-only inbound/outbound. Media (image/voice/file/video)
 * and typing indicators are ignored.
 *
 * Loaded by the gateway when `@openhermit/channel-wechat` is listed under
 * `channelPackages` in gateway config. See `docs/channel-plugin-design.md`.
 */
import type { ChannelManifest } from '@openhermit/protocol';

import { WechatBridge } from './bridge.js';
import { WechatBot } from './bot.js';
import { createWechatSetup } from './setup.js';

interface WechatRuntimeConfig {
  enabled?: boolean;
  /** iLink bot token returned at QR-login confirm. */
  bot_token: string;
  /** IDC-redirected per-bot base URL returned at QR-login confirm. */
  base_url: string;
  /** Server-issued ilink bot id; surfaced for diagnostics. */
  ilink_bot_id?: string;
  /** Optional override for the BaseInfo bot_agent header. */
  bot_agent?: string;
}

const manifest: ChannelManifest = {
  manifestVersion: 1,
  key: 'wechat',
  namespace: 'wechat',
  displayName: 'WeChat',
  start: async (rawConfig, context) => {
    const config = rawConfig as WechatRuntimeConfig;
    const log = (msg: string): void => context.logger('wechat', msg);

    if (!config.bot_token?.trim() || !config.base_url?.trim()) {
      log('missing bot_token or base_url — channel disabled until linked via setup');
      return undefined;
    }

    const bridge = new WechatBridge(
      {
        baseUrl: config.base_url,
        botToken: config.bot_token,
        ...(config.ilink_bot_id ? { ilinkBotId: config.ilink_bot_id } : {}),
      },
      {
        baseUrl: context.agentBaseUrl,
        token: context.agentTokens['wechat'] ?? '',
      },
      log,
    );

    const bot = new WechatBot({
      baseUrl: config.base_url,
      botToken: config.bot_token,
      bridge,
      logger: log,
    });
    await bot.start();

    return {
      name: 'wechat',
      outbound: bridge,
      stop: () => bot.stop(),
    };
  },
  setup: createWechatSetup(),
};

export default manifest;
