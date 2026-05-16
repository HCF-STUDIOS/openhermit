/**
 * Public entry point for `@openhermit/channel-wechat`.
 *
 * The default export is the `ChannelManifest`, consumed by the gateway's
 * plugin loader. Named exports are provided for ad-hoc tooling and tests.
 */
export { WechatBridge } from './bridge.js';
export { WechatBot } from './bot.js';
export { WeixinQrLogin } from './ilink/login.js';
export type { QrLoginSnapshot, QrLoginResult } from './ilink/login.js';
export type { WeixinMessage, MessageItem, GetUpdatesResp } from './ilink/types.js';
export type { ChannelOutbound, ChannelOutboundResult } from '@openhermit/protocol';

export { default } from './manifest.js';
