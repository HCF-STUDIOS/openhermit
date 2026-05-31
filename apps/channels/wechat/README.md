# WeChat Channel Adapter

`@openhermit/channel-wechat` connects a personal WeChat (Weixin) bot to a
gateway-managed OpenHermit agent over Tencent's **iLink** HTTP protocol.

## Scope

- Text inbound and outbound.
- **Inbound images**: photos are downloaded from the WeChat C2C CDN and
  AES-128-ECB decrypted, then uploaded to the agent as attachments (images
  become vision input). Attachments over the 25 MiB cap are skipped. The CDN
  base defaults to `https://novac2c.cdn.weixin.qq.com/c2c`, overridable via
  `OPENHERMIT_WECHAT_CDN_BASE_URL`; a server-provided `full_url` is preferred.
- Inbound voice / file / video and all **outbound** media are not handled yet
  (voice needs SILK transcoding; outbound needs the CDN upload flow).
- QR-link wizard (`ChannelSetup`) returns the QR URL as a plain string;
  the admin UI renders it with its own QR-code library.
- No typing indicators, no multi-account juggling.

The CDN download + AES decryption is ported from Tencent's MIT-licensed
[`openclaw-weixin`](https://github.com/Tencent/openclaw-weixin) (see the
header in `src/ilink/media.ts`).

## Loading the plugin

This package is **not** bundled into the gateway by default. Add it to
the gateway config:

```jsonc
{
  "channelPackages": ["@openhermit/channel-wechat"]
}
```

On gateway boot the plugin loader picks it up via dynamic import and
registers the `wechat` channel manifest with the runtime registry as
an `external` origin — so unlike `telegram` / `slack` / `discord`, no
row is auto-seeded into `agent_channels` on agent create. Owners add
WeChat on demand from the UI's "Add channel" picker.

## Linking a bot

1. In `/manage/channels` (web) or `/admin/channels` (gateway admin),
   click **Add channel** → pick **WeChat**.
2. The wizard renders a QR code (`qrText` carries the URL).
3. Open WeChat on your phone, scan the QR, confirm on phone. On
   confirmation the gateway persists the `agent_channels` row and the
   channel comes online.

## Stored config

After setup, the `agent_channels.config` row carries:

| key             | value                                       |
|-----------------|---------------------------------------------|
| `bot_token`     | iLink bot token                             |
| `base_url`      | IDC-redirected per-bot base URL             |
| `ilink_bot_id`  | server-issued bot id (diagnostics)          |
| `ilink_user_id` | scanner's iLink user id (optional)          |
| `bot_agent`     | optional override for the `User-Agent`-style header |

## iLink-App-Id

Tencent's iLink protocol carries an `iLink-App-Id` header read from
this package's own `package.json` (`ilink_appid`). Operators running
their own iLink app should either:

- patch the `ilink_appid` field in `package.json`, or
- set the `OPENHERMIT_WECHAT_APP_ID` env var on the gateway process.

The default empty value works against Tencent's public iLink endpoints
for testing only.
