# @openhermit/channel-lark

OpenHermit channel plugin for **Lark / 飞书 (Feishu)**.

Uses the platform's **WebSocket long-connection** event mode — no public URL,
webhook, or tunnel required. The gateway only needs outbound internet access.

Supports both platforms: **飞书** (`open.feishu.cn`, China) and
**Lark international** (`open.larksuite.com`) — pick via the `domain` config.

## Features

- Text messages in both directions (long replies auto-chunked)
- Inbound images / files / audio → session attachments (vision input for images)
- Outbound agent attachments → native Lark image / file messages
- Group chats with @mention gating (the agent replies only when @mentioned)
- `/new` (or `@bot new` in groups) starts a fresh conversation
- `session_send` reachability via `lark_chat_id` session metadata

## Install

```bash
hermit channel install @openhermit/channel-lark
# restart the gateway to load the plugin
```

## Lark app setup (one app per agent!)

> ⚠️ Lark allows **one live WebSocket connection per app**. Two gateways (or
> two agents) sharing an app_id will fight over the connection ("system
> busy"). Create a separate app for each agent — same rule as one Telegram
> bot token per agent.

1. **Create a self-built app** in the [Developer Console](https://open.feishu.cn)
   (or [open.larksuite.com](https://open.larksuite.com) for international
   tenants). Note the **App ID** (`cli_…`) and **App Secret**.
2. **Add the Bot capability** (App features → Bot).
3. **Grant permissions** (Permissions & Scopes). Minimum set:
   - `im:message` — send messages
   - `im:message.p2p_msg` — receive DMs
   - `im:message.group_at_msg` — receive group @mentions
     (**without this the bot receives nothing in groups** — the most common
     misconfiguration)
   - `im:resource` — upload/download message images & files
4. **Subscribe to events** (Event Subscriptions): choose **“Receive events
   through a persistent connection (WebSocket)”** as the delivery mode, then
   add the event `im.message.receive_v1`.
5. **Publish an app version** and approve it — permissions and events only
   take effect on a released version.
6. In the OpenHermit admin UI, enable the **Lark / 飞书** channel on the
   agent: paste the **App ID**, pick the **platform** (飞书 / Lark), and set
   the **App Secret** secret (`LARK_APP_SECRET`).

## Config

Stored in the agent's channel row:

```json
{
  "app_id": "cli_a1b2c3d4…",
  "app_secret": "${{LARK_APP_SECRET}}",
  "domain": "feishu"
}
```

| Field | Values | Notes |
| --- | --- | --- |
| `app_id` | `cli_…` | Developer Console → Credentials & Basic Info |
| `app_secret` | secret ref | via the `LARK_APP_SECRET` agent secret |
| `domain` | `feishu` (default) \| `lark` | which platform your tenant lives on |

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| Bot silent in groups, DMs fine | `im:message.group_at_msg` permission missing, or the app version wasn't republished after adding it |
| “system busy” / connection churn in logs | another process holds the app's WS connection — one app per agent |
| `bot info failed` at startup | wrong App ID/Secret, Bot capability not added, or app not published |
| Replies work but `session_send` can't reach the chat | the session predates this plugin — send one message in the chat to stamp `lark_chat_id` metadata |

## Not yet supported

- Interactive cards / rich-post outbound (replies are plain text)
- Sender display names (needs `contact:user.base:readonly`; planned)
- Inbound voice STT transcription (audio arrives as a file attachment)
- Webhook event mode (WS long connection only)
