# Slack Channel Adapter

`@openhermit/channel-slack` connects Slack events to a gateway-managed OpenHermit agent.

## Features

- Slack Socket Mode
- current-session-per-channel/thread routing using generated `slack:{date}-{random}` session IDs plus Slack metadata
- public/private channel and DM support where the app is installed
- mention-aware group routing
- sender identity extraction from Slack user IDs
- event deduplication for paired `message` and `app_mention` events
- optional `allowed_channel_ids` allow-list
- outbound delivery for `session_send`
- **media**: inbound `file_share` uploads are fetched (with bot-token auth) and uploaded to the agent (images become vision input); audio files are transcribed via STT. The agent's `attachment_send` deliveries are uploaded back via `files.uploadV2` (into the thread when applicable). Files over the 25 MiB cap are skipped.

The bot token needs the `files:read` scope to download inbound files and `files:write` to upload outbound ones.

## Configuration

```json
{
  "channels": {
    "slack": {
      "enabled": true,
      "bot_token": "${{SLACK_BOT_TOKEN}}",
      "app_token": "${{SLACK_APP_TOKEN}}",
      "allowed_channel_ids": ["C0123456789"]
    }
  }
}
```

```bash
hermit config secrets set SLACK_BOT_TOKEN <xoxb-token>
hermit config secrets set SLACK_APP_TOKEN <xapp-token>
```

See [../../../docs/channel-adapter.md](../../../docs/channel-adapter.md).
