/**
 * Channel plugin manifest for Lark / Feishu (飞书). Consumed by the
 * gateway's ChannelManifestRegistry; see `docs/channel-plugin-design.md`.
 *
 * Two event modes:
 * - `ws` (default): WebSocket long connection — no public URL, webhook,
 *   or tunnel required. One Lark app per agent (the platform allows a
 *   single live WS connection per app).
 * - `webhook`: gateway-hosted webhook. Lark has no programmatic
 *   setWebhook — the operator pastes the gateway URL into the Developer
 *   Console (it is logged at channel start).
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
    {
      key: 'LARK_ENCRYPT_KEY',
      label: 'Encrypt Key (webhook mode)',
      placeholder: 'Console → Events → Encrypt Key (optional)',
      optional: true,
    },
    {
      key: 'LARK_VERIFICATION_TOKEN',
      label: 'Verification Token (webhook mode)',
      placeholder: 'Console → Events → Verification Token (optional)',
      optional: true,
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
    {
      kind: 'select',
      key: 'mode',
      label: 'Event delivery',
      options: [
        { value: 'ws', label: 'WebSocket long connection (recommended — no public URL)' },
        { value: 'webhook', label: 'Webhook (paste the gateway URL into the Console)' },
      ],
      defaultValue: 'ws',
      help: 'Webhook mode needs a public gateway URL; the exact Request URL to paste is printed in the channel logs at start.',
    },
  ],
  defaultConfig: {
    app_id: '',
    app_secret: '${{LARK_APP_SECRET}}',
    domain: 'feishu',
    mode: 'ws',
    encrypt_key: '${{LARK_ENCRYPT_KEY}}',
    verification_token: '${{LARK_VERIFICATION_TOKEN}}',
  },
  parseConfig: parseLarkConfig,
  start: async (rawConfig, context) => {
    const config = rawConfig as LarkRuntimeConfig;
    const log = (msg: string): void => context.logger('lark', msg);

    const domainKey = config.domain === 'lark' ? 'lark' : 'feishu';
    const mode = config.mode === 'webhook' ? 'webhook' : 'ws';
    const api = new LarkApi(config.app_id, config.app_secret, domainKey, log);
    const bridge = new LarkBridge(
      api,
      {
        baseUrl: context.agentBaseUrl,
        token: context.agentTokens['lark'] ?? '',
      },
      log,
    );

    let webhookUrl: string | undefined;
    if (mode === 'webhook') {
      if (context.publicAgentBaseUrl === context.agentBaseUrl) {
        throw new Error(
          'Lark webhook mode needs a public URL. Set OPENHERMIT_GATEWAY_PUBLIC_URL on the gateway, or use mode "ws".',
        );
      }
      webhookUrl = `${context.publicAgentBaseUrl}/channels/lark/webhook`;
    }

    const bot = new LarkBot({
      appId: config.app_id,
      appSecret: config.app_secret,
      domainKey,
      mode,
      ...(config.encrypt_key ? { encryptKey: config.encrypt_key } : {}),
      ...(config.verification_token ? { verificationToken: config.verification_token } : {}),
      ...(webhookUrl ? { webhookUrl } : {}),
      api,
      bridge,
      logger: log,
      reportRuntimeError: context.reportRuntimeError,
    });
    await bot.start();

    return {
      name: 'lark',
      outbound: bridge,
      stop: async () => {
        await bot.stop();
        bridge.stop();
      },
      ...(mode === 'webhook'
        ? { handleWebhook: (req: Parameters<LarkBot['handleWebhookRequest']>[0]) => bot.handleWebhookRequest(req) }
        : {}),
    };
  },
};

export default manifest;
