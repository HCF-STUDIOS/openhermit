# Channel Adapters

A **channel** is an npm package that default-exports a `ChannelManifest` (`packages/protocol/src/index.ts`) describing how to talk to an external messaging platform. At gateway boot, the `ChannelManifestRegistry` (`apps/gateway/src/channel-manifests.ts`) registers every manifest — bundled defaults plus any package named in `gateway.config.channelPackages` — and the `ChannelPool` (`apps/gateway/src/channel-pool.ts`) starts every enabled adapter for every agent with `agents.status='active'`, registering scoped channel tokens so adapters can call back into `/api/agents/{agentId}/...`. Bridges are owned by the gateway, not by the per-agent runner — they stay alive across runner eviction and only tear down on gateway shutdown, agent disable, or explicit `disableChannel`. When an inbound message arrives, the gateway hydrates the runner on demand before dispatching.

For the design rationale behind manifests, see [`channel-plugin-design.md`](channel-plugin-design.md).

## Bundled Adapters

These ship inside the CLI binary and are registered automatically:

| Platform | Package | Connection |
|----------|---------|------------|
| Telegram | `@openhermit/channel-telegram` | polling or webhook; text + media (photos/docs/video, voice transcribed) |
| Discord | `@openhermit/channel-discord` | Discord gateway via `discord.js`; text + media (files/images, audio transcribed) |
| Slack | `@openhermit/channel-slack` | Slack Socket Mode; text + media (files/images, audio transcribed) |

## External Plugin Adapters

Not bundled in the CLI. Operators install them with `hermit channel install <pkg>` (or `npm install -g <pkg>` followed by adding to `channelPackages`); the gateway dynamic-imports each package at boot. No row is auto-seeded on agent create — owners add them via the admin UI's "Add channel" picker.

| Platform | Package | Connection |
|----------|---------|------------|
| Signal | `@openhermit/channel-signal` | signal-cli-rest-api WebSocket (`MODE=json-rpc`); QR-link setup wizard; text + media (files/images, audio transcribed) |
| WeChat (personal) | `@openhermit/channel-wechat` | iLink long-poll (`getUpdates`) — text + inbound images + inbound voice (SILK→STT) |
| WhatsApp | `@openhermit/channel-whatsapp` | WhatsApp Web via Baileys; QR setup wizard — text + media (image/video/document/voice) |

External plugins follow the same manifest contract as bundled ones — there is no special-case loading path. Adding a new external plugin requires no gateway code change, only a config edit and a restart.

## Session Routing

Adapters keep a current session per external conversation and recover it by listing sessions with channel metadata.

| Platform | Generated session prefix | Metadata used for recovery |
|----------|--------------------------|----------------------------|
| Telegram | `telegram:` | `telegram_chat_id` |
| Discord | `discord:` | `discord_channel_id` |
| Slack | `slack:` | `slack_channel_id`, optional `slack_thread_ts` |
| Signal | `signal:` (DMs by uuid or E.164) / `signal:group:` | `signal_source`, optional `signal_group_id` |
| WhatsApp | `whatsapp:` / `whatsapp:group:` | `whatsapp_chat_jid`, optional `whatsapp_group_jid` |

`/new` creates a new generated session ID after checkpointing the previous session with reason `new_session`.

## Message Flow

1. Platform event arrives.
2. Adapter resolves or creates the current OpenHermit session.
3. Adapter calls `openSession()` with source metadata.
4. Adapter calls `postMessage()` with text, `sender`, and `mentioned`.
5. Runtime persists the message and emits `user_message`.
6. Runtime applies group routing.
7. If triggered, adapter reads SSE events until `agent_end`.
8. Adapter sends or edits platform messages from the final response.

## Group Routing

The runtime applies channel-agnostic group behavior:

- owners always trigger the agent
- non-owner mentioned messages trigger the agent
- non-owner unmentioned messages are logged but do not trigger a model turn
- `<NO_REPLY>` markers are stripped from final responses by adapters (the legacy `<EMPTY_RESPONSE>` token is also accepted); if the stripped remainder is empty the reply is suppressed entirely, otherwise the remainder is sent without the marker. Streaming edits apply the same stripping so a token appearing mid-stream never flashes in the channel.

## Outbound Messages

Adapters register `ChannelOutbound` implementations. The `session_send` tool can send proactive messages through them; the delivery is recorded in the target session as a normal assistant log entry, with `channel`, `to`, `messageId`, and `fromSession` as sibling keys under `metadata` and a `metadata.source = 'session_send'` marker.

## Configuration

Channels are stored in the `agent_channels` table and managed through the admin UI (*Manage → Channels*) or the REST routes below. Channel rows and related credentials use three storage slots:

- **`config` (jsonb, plaintext)** — non-secret adapter settings and setup-produced pointers. Some existing adapters still store upstream tokens here (for example WeChat `bot_token` + `base_url`); treat the database itself as the security boundary for those rows.
- **`token_ciphertext` (text, AES-256-GCM)** — the bearer token OpenHermit *issues* to that channel, used by webhook ingress (`POST /api/agents/.../channels/.../webhook`) and by adapters calling back into the gateway API. Encrypted at rest with `OPENHERMIT_SECRETS_KEY` and decrypted only when an adapter starts.
- **`agent_channel_credentials` (AES-256-GCM values)** — mutable channel-owned auth material such as WhatsApp Web / Baileys credentials. Plugins receive this as a scoped credential store; values are not exposed through channel config.

To install or remove gateway-wide channel plugins (npm packages contributing new channel types), use:

```bash
hermit channel install   <pkg>    # npm install -g <pkg> + append to channelPackages
hermit channel uninstall <pkg>    # remove from channelPackages + npm uninstall -g <pkg>
hermit channel list
```

A gateway restart is required for plugin changes to take effect. The `channelPackages` array is also editable via `hermit gateway config set channelPackages '[...]'` or directly in *Admin → Gateway Config*.

## Runtime Management API

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/agents/{agentId}/channels` | list configured channels and status |
| `POST` | `/api/agents/{agentId}/channels/{channelId}/enable` | enable and start |
| `POST` | `/api/agents/{agentId}/channels/{channelId}/disable` | disable and stop |
| `PUT` | `/api/agents/{agentId}/channels/{channelId}` | update config/secrets |
| `DELETE` | `/api/agents/{agentId}/channels/{channelId}` | remove config |

These routes require owner or admin auth.

## Interactive Setup (QR Scan, OAuth Device Flow)

Token-paste channels (Telegram, Discord, Slack) start with a known `config` — the operator pastes a bot token and saves the row. Channels whose credentials are only obtainable after an external action — WeChat QR scan, Signal device-link, OAuth device flow — implement the optional `ChannelManifest.setup` state machine. The contract lives in `packages/protocol/src/index.ts` (`ChannelSetup`, `ChannelSetupState`) and is wrapped by four gateway routes:

```
POST   /api/agents/:id/channels/:type/setup/begin              -> { sessionId, state }
GET    /api/agents/:id/channels/:type/setup/:sessionId         -> { sessionId, state }   (poll)
POST   /api/agents/:id/channels/:type/setup/:sessionId         -> { sessionId, state }   (submit)
DELETE /api/agents/:id/channels/:type/setup/:sessionId         -> { ok: true }            (cancel)
```

The UI switch-renders on `state.kind`:

- `awaiting_user_input` — form (e.g. phone number for Signal)
- `awaiting_external` — render `qrText` as a QR code, or surface `redirectUrl` as a button; poll every `pollIntervalMs`
- `done` — the UI takes `state.config` and POSTs / PATCHes it onto the channel row via the existing CRUD API (the setup contract itself does **not** write to the DB)
- `error` — display `message` verbatim

Session state lives in-process inside the plugin (`Map<sessionId, ...>`); the gateway is stateless. Sessions are bounded by a plugin-chosen TTL (WeChat: 5 min; Signal/WhatsApp: 10 min). On gateway restart, in-flight setup sessions are lost — the UI restarts the wizard. **Completed setups survive restart** because durable setup output lives either on the channel row (`agent_channels.config`) or in scoped encrypted channel credentials (`agent_channel_credentials`), then the adapter reloads that state on start.



For platforms that push updates over HTTPS (e.g. Telegram in webhook
mode, Slack Events API, Discord Interactions), the gateway exposes a
single public ingress per channel:

```
POST /api/agents/{agentId}/channels/{namespace}/webhook
```

- `namespace` is the per-agent unique identifier on the channel row. For
  built-in channels it equals the channel type (`telegram`, `discord`,
  `slack`); for external rows it is owner-chosen at create time.
- The route is unauthenticated at the gateway layer — authentication is
  the adapter's responsibility (Telegram `secret_token` header, Slack
  HMAC signing, Discord ed25519 signature). The dispatcher hands the
  raw headers and body to the live bridge via `handleWebhook(req)`.
- One port, one TLS cert: a single Caddy / Tailscale / Cloudflare proxy
  in front of the gateway covers every agent × channel combination. No
  per-adapter HTTP server is started.

### Telegram in webhook mode

When a Telegram channel is enabled with `mode: "webhook"`, the gateway
on adapter start:

1. Computes the URL `${GATEWAY_PUBLIC_URL}/api/agents/{id}/channels/telegram/webhook`.
2. Calls Telegram's `setWebhook(url, secret_token)` using the channel's
   stored bearer token as `secret_token`.
3. On every incoming POST, the bridge verifies the
   `X-Telegram-Bot-Api-Secret-Token` header against the same value and
   returns `401` on mismatch.

This means the Telegram webhook URL never has to be manually configured
or rotated — flipping `mode` between `polling` and `webhook` in the
admin UI re-derives and re-registers it automatically.

## Platform Notes

Telegram:

- direct Bot API client
- polling and webhook modes
- throttled message edits for streaming output
- optional `allowed_chat_ids`
- media inbound (photos/documents/video uploaded as session attachments — images become vision input — with captions kept as text; voice/audio transcribed via STT) and outbound (`attachment_send` → sendPhoto/sendDocument/sendVideo/sendVoice); inbound files over Telegram's ~20 MB Bot API download limit are skipped

Discord:

- `discord.js` v14
- guild messages and DMs
- mention detection before routing
- optional `allowed_channel_ids`
- media inbound (CDN attachments uploaded as session attachments; images become vision input; audio transcribed via STT) and outbound (`attachment_send` → Discord file upload); media over the 25 MiB cap is skipped

Slack:

- Socket Mode with bot token plus app token
- channel, DM, and thread metadata
- deduplicates paired message/app-mention events
- media inbound (`file_share` uploads fetched with bot-token auth and uploaded as session attachments; images become vision input; audio transcribed via STT) and outbound (`attachment_send` → `files.uploadV2`, into the thread when applicable); files over the 25 MiB cap are skipped. Needs `files:read` + `files:write` scopes.
- optional `allowed_channel_ids`

Signal (external plugin):

- signal-cli-rest-api WebSocket receive (`MODE=json-rpc`); QR-link setup wizard
- media inbound (attachments fetched via `GET /v1/attachments/{id}` and uploaded as session attachments — images become vision input — audio transcribed via STT) and outbound (`attachment_send` → `base64_attachments` on `/v2/send`); attachments over the 25 MiB cap are skipped
- DMs open by default unless `allowed_senders` is set; groups default-deny unless `allowed_group_ids` is set

WeChat (external plugin):

- iLink long-poll loop on `bot_token` — no per-message webhook
- QR-link setup wizard exchanges scan+confirmation for `bot_token` + IDC-pinned `base_url`; both persist on the channel row
- inbound images: photos are downloaded from the WeChat C2C CDN and AES-128-ECB decrypted, then uploaded as session attachments (vision input); over the 25 MiB cap they are skipped
- inbound voice: SILK voice notes are downloaded + decrypted, transcoded to WAV via `silk-wasm`, and transcribed via the agent's STT (prefixed with a `[Voice message, transcribed.]` marker); WeChat's own `voice_item.text` transcript is used directly when present. Inbound file/video and all outbound media are not handled yet
- no group filtering
- `errcode === -14` from `getUpdates` is treated as long-poll cursor reset, **not** auth failure

WhatsApp (external plugin):

- WhatsApp Web / Linked Devices through Baileys; no Twilio or WhatsApp Cloud API path
- QR setup wizard stores Baileys credentials in encrypted DB channel credentials and persists `auth_profile` on the channel row
- media inbound (image/video/document uploaded as attachments, captions kept as text) and outbound (`attachment_send` → image/video/document/voice note); voice notes are transcribed via STT and replies spoken via TTS when configured; media over the 25 MiB cap is skipped
- DMs are open by default unless `allowed_senders` is configured
- groups are default-deny unless `allowed_group_jids` is configured; allowed group turns trigger only on mention
- status, broadcast, and own linked-account messages are ignored
