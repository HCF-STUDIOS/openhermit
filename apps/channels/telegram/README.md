# Telegram Channel Adapter

`@openhermit/channel-telegram` connects a Telegram bot to a gateway-managed OpenHermit agent.

## Features

- polling or webhook mode
- current-session-per-chat routing using generated `telegram:{date}-{random}` session IDs plus `telegram_chat_id` metadata
- private chat and group chat support
- sender identity extraction from Telegram user metadata
- auto-guest creation through the agent runtime's user resolver
- `/start` and `/new`
- mention-aware group routing
- streamed response edits with Telegram rate-limit throttling
- outbound agent-to-Telegram delivery for `session_send`
- **media**: inbound photos / documents / video are uploaded to the agent (images become vision input) with captions kept as text, and voice / audio notes are transcribed via STT (replies spoken back via TTS when configured); the agent's `attachment_send` deliveries go out as the matching Telegram send (photo / document / video / voice). Inbound files over Telegram's ~20 MB Bot API download limit are skipped.

## Configuration

Channels are stored in the `agent_channels` table with encrypted tokens. Add via admin UI, REST API, or CLI:

```bash
hermit channels enable telegram --agent <agentId> --token <bot-token> --mode polling
```

Stored config keys:

- `mode`: `polling` or `webhook`
- `webhook_url`: public webhook URL
- `webhook_port`: local webhook listener port
- `allowed_chat_ids`: allow-list of chat IDs

## Structure

```text
src/
  bot.ts            # Telegram Bot API polling/webhook loop
  bridge.ts         # Telegram <-> OpenHermit session bridge
  formatting.ts     # Markdown/plain text formatting
  telegram-api.ts   # Direct Telegram Bot API client
```

See [../../../docs/channel-adapter.md](../../../docs/channel-adapter.md).
