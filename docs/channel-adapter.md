# Channel Adapters

OpenHermit includes built-in Telegram, Discord, and Slack adapters. At gateway boot the `ChannelPool` (`apps/gateway/src/channel-pool.ts`) starts every enabled adapter for every agent with `agents.status='active'` and registers scoped channel tokens so adapters can call back into `/api/agents/{agentId}/...`. Bridges are owned by the gateway, not by the per-agent runner — they stay alive across runner eviction and only tear down on gateway shutdown, agent disable, or explicit `disableChannel`. When an inbound message arrives, the gateway hydrates the runner on demand before dispatching.

## Implemented Adapters

| Platform | Package | Connection |
|----------|---------|------------|
| Telegram | `@openhermit/channel-telegram` | polling or webhook |
| Discord | `@openhermit/channel-discord` | Discord gateway via `discord.js` |
| Slack | `@openhermit/channel-slack` | Slack Socket Mode |

## Session Routing

Adapters keep a current session per external conversation and recover it by listing sessions with channel metadata.

| Platform | Generated session prefix | Metadata used for recovery |
|----------|--------------------------|----------------------------|
| Telegram | `telegram:` | `telegram_chat_id` |
| Discord | `discord:` | `discord_channel_id` |
| Slack | `slack:` | `slack_channel_id`, optional `slack_thread_ts` |

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
- exact `<NO_REPLY>` final responses are suppressed by adapters

## Outbound Messages

Adapters register `ChannelOutbound` implementations. The `session_send` tool can send proactive messages through them; the delivery is recorded in the target session as a normal assistant log entry, with `channel`, `to`, `messageId`, and `fromSession` as sibling keys under `metadata` and a `metadata.source = 'session_send'` marker.

## Configuration

Channels are stored in the `agent_channels` table (config + encrypted token columns) and managed through the admin UI, CLI (`hermit channels ...`), or the REST routes below. Tokens never live in `config.json`; they are encrypted at rest and decrypted only when an adapter starts.

## Runtime Management API

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/agents/{agentId}/channels` | list configured channels and status |
| `POST` | `/api/agents/{agentId}/channels/{channelId}/enable` | enable and start |
| `POST` | `/api/agents/{agentId}/channels/{channelId}/disable` | disable and stop |
| `PUT` | `/api/agents/{agentId}/channels/{channelId}` | update config/secrets |
| `DELETE` | `/api/agents/{agentId}/channels/{channelId}` | remove config |

These routes require owner or admin auth.

## Webhook Ingress

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

Discord:

- `discord.js` v14
- guild messages and DMs
- mention detection before routing
- optional `allowed_channel_ids`

Slack:

- Socket Mode with bot token plus app token
- channel, DM, and thread metadata
- deduplicates paired message/app-mention events
- optional `allowed_channel_ids`
