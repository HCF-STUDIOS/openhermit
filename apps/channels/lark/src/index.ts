/**
 * Public entry point for `@openhermit/channel-lark`.
 *
 * The default export is the `ChannelManifest`, consumed by the gateway's
 * plugin loader. Named exports are provided for ad-hoc tooling and tests.
 */
export { LarkBridge } from './bridge.js';
export type { LarkInboundMessage } from './bridge.js';
export { LarkBot } from './bot.js';
export type { WebhookRequestLike, WebhookResponseLike } from './bot.js';
export { LarkApi } from './lark-api.js';
export { parseLarkConfig } from './config.js';
export type { LarkRuntimeConfig } from './config.js';
export {
  parseMessageContent,
  isBotMentioned,
  stripMentionPlaceholders,
  chunkText,
} from './parse.js';
export type { LarkMention, ParsedContent } from './parse.js';
export type { ChannelOutbound, ChannelOutboundResult } from '@openhermit/protocol';

export { default } from './manifest.js';
