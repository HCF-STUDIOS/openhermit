# Discord Channel Adapter

`@openhermit/channel-discord` connects Discord messages to a gateway-managed OpenHermit agent.

## Features

- Discord gateway connection via `discord.js`
- current-session-per-channel routing using generated `discord:{date}-{random}` session IDs plus `discord_channel_id` metadata
- guild channel and DM support
- mention-aware group routing
- sender identity extraction from Discord user IDs and display names
- optional `allowed_channel_ids` allow-list
- outbound delivery for `session_send`
- **media**: inbound file/image attachments are uploaded to the agent (images become vision input) and audio attachments are transcribed via STT; the agent's `attachment_send` deliveries are sent back as Discord file uploads. Attachments over the 25 MiB cap are skipped.

## Configuration

Channels live in the `agent_channels` table (encrypted tokens). Manage via admin UI, the `/api/agents/{agentId}/channels/discord` REST routes, or CLI:

```bash
hermit channels enable discord --agent <agentId> --token <bot-token>
```

Optional config: `allowed_channel_ids` allow-list. The bot needs message content access and the gateway intents required for guild messages and direct messages.

See [../../../docs/channel-adapter.md](../../../docs/channel-adapter.md).
