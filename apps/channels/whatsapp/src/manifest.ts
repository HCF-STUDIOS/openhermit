/**
 * Channel plugin manifest for WhatsApp Web (Baileys).
 *
 * Loaded by the gateway when `@openhermit/channel-whatsapp` is listed under
 * `channelPackages` in gateway config. See `docs/channel-plugin-design.md`.
 */
import type { ChannelManifest } from '@openhermit/protocol';

import { WhatsAppBot } from './bot.js';
import { WhatsAppBridge } from './bridge.js';
import { createWhatsAppSetup, expandHome } from './setup.js';
import { WhatsAppApi } from './whatsapp-api.js';

interface WhatsAppRuntimeConfig {
  enabled?: boolean;
  auth_dir: string;
  allowed_senders?: string[];
  allowed_group_jids?: string[];
}

const manifest: ChannelManifest = {
  manifestVersion: 1,
  key: 'whatsapp',
  namespace: 'whatsapp',
  displayName: 'WhatsApp',
  configFields: [
    {
      kind: 'text',
      key: 'auth_dir',
      label: 'Auth directory',
      placeholder: '~/.openhermit/credentials/whatsapp/<agent>/default',
      help: 'Filled by setup. Edit only if you moved the Baileys auth files.',
    },
    {
      kind: 'string_list',
      key: 'allowed_senders',
      label: 'Allowed senders (optional)',
      placeholder: '+15551234567, 15551234567@s.whatsapp.net',
      help: 'Leave blank to allow direct messages from anyone.',
    },
    {
      kind: 'string_list',
      key: 'allowed_group_jids',
      label: 'Allowed group JIDs',
      placeholder: '120363000000000000@g.us, *',
      help: 'Groups are ignored unless listed. Use * to allow every group.',
    },
  ],

  start: async (rawConfig, context) => {
    const config = rawConfig as WhatsAppRuntimeConfig;
    const log = (msg: string): void => context.logger('whatsapp', msg);
    const authDir = typeof config.auth_dir === 'string' ? config.auth_dir.trim() : '';

    if (!authDir) {
      log('missing auth_dir - channel disabled until linked via setup');
      return undefined;
    }

    const api = new WhatsAppApi({
      authDir: expandHome(authDir),
      logger: log,
      reportRuntimeError: context.reportRuntimeError,
    });

    const bridgeOptions: { allowedSenders?: string[]; allowedGroupJids?: string[] } = {};
    if (config.allowed_senders) bridgeOptions.allowedSenders = config.allowed_senders;
    if (config.allowed_group_jids) bridgeOptions.allowedGroupJids = config.allowed_group_jids;

    const bridge = new WhatsAppBridge(
      api,
      {
        baseUrl: context.agentBaseUrl,
        token: context.agentTokens['whatsapp'] ?? '',
      },
      bridgeOptions,
      log,
    );

    const bot = new WhatsAppBot({ whatsapp: api, bridge, logger: log });
    await bot.start();

    return {
      name: 'whatsapp',
      outbound: bridge,
      stop: () => bot.stop(),
    };
  },

  setup: createWhatsAppSetup(),
};

export default manifest;
