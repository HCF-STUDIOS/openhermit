/**
 * Public entry point for `@openhermit/channel-whatsapp`.
 *
 * The default export is the `ChannelManifest`, consumed by the gateway's
 * plugin loader. Named exports are provided for tests and ad-hoc tooling.
 */
export { WhatsAppBot } from './bot.js';
export {
  cleanBotCommandText,
  conversationKey,
  generateSessionId,
  groupAllowed,
  isBroadcastJid,
  isGroupJid,
  jidToPhone,
  normalizeJid,
  phoneToJid,
  senderAllowed,
  targetToJid,
} from './jid.js';
export { WhatsAppBridge, shouldAcceptMessage } from './bridge.js';
export { WhatsAppApi } from './whatsapp-api.js';
export {
  createWhatsAppSetup,
  defaultAuthDir,
  expandHome,
  collapseHome,
} from './setup.js';
export type {
  WhatsAppIncomingMessage,
  WhatsAppBridgeOptions,
} from './bridge.js';
export type {
  RawWhatsAppMessage,
  RawWhatsAppMessageHandler,
} from './whatsapp-api.js';
export type {
  WhatsAppLinkSession,
  WhatsAppLinkSnapshot,
  StartWhatsAppLinkSession,
} from './setup.js';
export type { ChannelOutbound, ChannelOutboundResult } from '@openhermit/protocol';

export { default } from './manifest.js';
