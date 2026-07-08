/**
 * Channel plugin manifest for Lark / Feishu (飞书). Consumed by the
 * gateway's ChannelManifestRegistry; see `docs/channel-plugin-design.md`.
 *
 * Uses the platform's WebSocket long-connection event mode — no public
 * URL, webhook, or tunnel required. One Lark app per agent (the platform
 * allows a single live WS connection per app).
 */
import type { ChannelManifest } from '@openhermit/protocol';

import { parseLarkConfig, type LarkRuntimeConfig } from './config.js';
import { LarkApi } from './lark-api.js';
import { LarkBridge } from './bridge.js';
import { LarkBot } from './bot.js';

const manifest: ChannelManifest = {
  manifestVersion: 1,
  key: 'lark',
  namespace: 'lark',
  displayName: 'Lark / 飞书',
  secretKeys: [
    {
      key: 'LARK_APP_SECRET',
      label: 'App Secret',
      placeholder: 'Developer Console → Credentials & Basic Info',
    },
  ],
  configFields: [
    {
      kind: 'text',
      key: 'app_id',
      label: 'App ID',
      placeholder: 'cli_a1b2c3d4…',
      help: 'From the Lark/Feishu Developer Console. Create a self-built app with the Bot capability; one app per agent.',
    },
    {
      kind: 'select',
      key: 'domain',
      label: 'Platform',
      options: [
        { value: 'feishu', label: '飞书 (open.feishu.cn)' },
        { value: 'lark', label: 'Lark international (open.larksuite.com)' },
      ],
      defaultValue: 'feishu',
    },
  ],
  defaultConfig: {
    app_id: '',
    app_secret: '${{LARK_APP_SECRET}}',
    domain: 'feishu',
  },
  parseConfig: parseLarkConfig,
  start: async (rawConfig, context) => {
    const config = rawConfig as LarkRuntimeConfig;
    const log = (msg: string): void => context.logger('lark', msg);

    const domainKey = config.domain === 'lark' ? 'lark' : 'feishu';
    const api = new LarkApi(config.app_id, config.app_secret, domainKey, log);
    const bridge = new LarkBridge(
      api,
      {
        baseUrl: context.agentBaseUrl,
        token: context.agentTokens['lark'] ?? '',
      },
      log,
    );

    const bot = new LarkBot({
      appId: config.app_id,
      appSecret: config.app_secret,
      domainKey,
      api,
      bridge,
      logger: log,
      reportRuntimeError: context.reportRuntimeError,
    });
    await bot.start();

    return {
      name: 'lark',
      outbound: bridge,
      stop: () => bot.stop(),
    };
  },
};

export default manifest;
