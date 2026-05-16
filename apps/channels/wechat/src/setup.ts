/**
 * `ChannelSetup` adapter for the iLink QR-login wizard.
 *
 * `begin()` kicks off a QR-login session (returning the QR URL for the UI
 * to render); `poll()` snapshots the background poller's progress; on
 * `confirmed`, returns a `done` state whose `config` payload is what the
 * gateway persists to the `agent_channels` row.
 */
import type {
  ChannelSetup,
  ChannelSetupContext,
  ChannelSetupState,
} from '@openhermit/protocol';

import { WeixinQrLogin } from './ilink/login.js';

export const createWechatSetup = (): ChannelSetup => {
  const login = new WeixinQrLogin();

  const toState = (sessionId: string, ctx: ChannelSetupContext): ChannelSetupState => {
    const snap = login.read(sessionId);
    if (!snap) {
      return {
        kind: 'error',
        message: 'WeChat setup session not found or expired.',
      };
    }
    if (snap.kind === 'pending') {
      const instructions =
        snap.status === 'scaned'
          ? 'Scanned — confirm the login on your phone.'
          : 'Open WeChat on your phone and scan this QR code to link the bot.';
      return {
        kind: 'awaiting_external',
        instructions,
        qrText: snap.qrcodeUrl,
        pollIntervalMs: 1500,
      };
    }
    if (snap.kind === 'error') {
      // Drop the session so the wizard can restart cleanly.
      void login.cancel(sessionId);
      return { kind: 'error', message: snap.message };
    }
    // done
    void login.cancel(sessionId);
    ctx.logger(`QR login confirmed for bot ${snap.result.ilinkBotId}`);
    return {
      kind: 'done',
      config: {
        bot_token: snap.result.botToken,
        base_url: snap.result.baseUrl,
        ilink_bot_id: snap.result.ilinkBotId,
        ...(snap.result.ilinkUserId ? { ilink_user_id: snap.result.ilinkUserId } : {}),
      },
    };
  };

  return {
    begin: async (_input, ctx) => {
      const { sessionId } = await login.start({ log: (m) => ctx.logger(m) });
      return { sessionId, state: toState(sessionId, ctx) };
    },
    poll: async (sessionId, ctx) => toState(sessionId, ctx),
    cancel: async (sessionId) => login.cancel(sessionId),
  };
};
