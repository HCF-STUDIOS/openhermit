/**
 * Channel plugin manifest for WhatsApp Web (Baileys).
 *
 * Loaded by the gateway when `@openhermit/channel-whatsapp` is listed under
 * `channelPackages` in gateway config. See `docs/channel-plugin-design.md`.
 */
import type { ChannelManifest } from '@openhermit/protocol';

import { WhatsAppBot } from './bot.js';
import { WhatsAppBridge } from './bridge.js';
import {
  DEFAULT_AUTH_PROFILE,
  createWhatsAppSetup,
  removeLegacyAuthDir,
} from './setup.js';
import { WhatsAppApi } from './whatsapp-api.js';

interface WhatsAppRuntimeConfig {
  enabled?: boolean;
  auth_profile?: string;
  /** Legacy filesystem auth path. No longer supported; cleaned up on sight. */
  auth_dir?: string;
  allowed_senders?: string[];
  allowed_group_jids?: string[];
}

const manifest: ChannelManifest = {
  manifestVersion: 1,
  key: 'whatsapp',
  namespace: 'whatsapp',
  displayName: 'WhatsApp',
  defaultConfig: { auth_profile: DEFAULT_AUTH_PROFILE },
  configFields: [
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
    const legacyAuthDir = typeof config.auth_dir === 'string' ? config.auth_dir.trim() : '';

    if (legacyAuthDir) {
      const cleanup = await removeLegacyAuthDir(legacyAuthDir);
      if (cleanup.removed) {
        log(`removed legacy auth_dir ${cleanup.removed}`);
      } else if (cleanup.skipped) {
        log(`legacy auth_dir is outside the managed WhatsApp credentials root; skipped delete: ${cleanup.skipped}`);
      } else if (cleanup.error) {
        log(`failed to remove legacy auth_dir: ${cleanup.error}`);
      }
      throw new Error('WhatsApp auth_dir is no longer supported; run WhatsApp setup again to store credentials in the database.');
    }

    if (!context.credentialStore) {
      throw new Error('WhatsApp credentials require DATABASE_URL and OPENHERMIT_SECRETS_KEY. Configure both and restart the gateway.');
    }

    const authProfile = typeof config.auth_profile === 'string' && config.auth_profile.trim()
      ? config.auth_profile.trim()
      : DEFAULT_AUTH_PROFILE;

    const api = new WhatsAppApi({
      authProfile,
      credentialStore: context.credentialStore,
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
      stop: async () => {
        await bot.stop();
        bridge.stop();
      },
    };
  },

  setup: createWhatsAppSetup(),
};

export default manifest;
