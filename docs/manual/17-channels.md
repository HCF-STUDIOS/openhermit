---
title: Channels
slug: channels
order: 17
part: Part 4 — Configuring Your Agent
description: CLI, Web, Telegram, Discord, Slack — how to attach the agent to the places you actually talk.
---

# 17. Channels

A **channel** is a transport for messages: the CLI, the web UI, a Telegram bot, a Discord bot, a Slack app. The agent is the same in every channel — same memory, same tools, same instructions. The channel just decides where you type and how attachments come in.

---

## 17.1 The Channels You Get

**Bundled with the CLI** (always available once `openhermit` is installed):

- **CLI** — `hermit chat`. Always available if you have the CLI installed.
- **Web** — `https://<your-gateway>/chat/<agent>`. Always available once the gateway is reachable.
- **Telegram** — bot you create via BotFather, registered with the agent.
- **Discord** — bot application registered with the agent.
- **Slack** — Slack app installed into your workspace, registered with the agent.

**Installable as npm packages** (add via `hermit channel install`):

- **WeChat (personal)** — `@openhermit/channel-wechat`. Pair an existing personal WeChat account with the agent using a QR-scan wizard. Text, inbound images, and inbound voice (transcribed).
- **WhatsApp** — `@openhermit/channel-whatsapp`. Link a WhatsApp account through WhatsApp Web / Linked Devices using a QR-scan wizard. Supports text plus media (images/video/documents as attachments; voice notes transcribed).

Each non-CLI channel needs a credential (a bot token, app secret, or linked-device auth state). Operator-entered tokens are stored as secrets — see [Chapter 18](18-secrets.md). Channel-owned auth state, such as WhatsApp Web credentials, is stored in encrypted channel credential rows.

Newer adapters may exist (e.g., Signal); the *Manage → Channels* tab is the source of truth for which adapters your gateway has.

---

## 17.2 Managing Channels

Per-agent channel configuration (enabling Telegram, setting Discord bot tokens, issuing webhook tokens, etc.) lives in *Manage → Channels* or under the `/api/agents/<agent-id>/channels` API. The API lists configured channels, creates owner-issued external channels, patches existing channel config (`enabled`, secrets, and adapter options), and deletes channels. Built-in channels such as Telegram, Discord, and Slack are seeded as channel rows and are enabled by patching their config.

To install or remove **gateway-wide channel plugins** (npm packages that contribute new channel types), use the `hermit channel` command:

```bash
hermit channel install <pkg>      # npm install -g <pkg> + append to channelPackages
hermit channel uninstall <pkg>    # remove from channelPackages + npm uninstall -g <pkg>
hermit channel list               # show registered channel packages
```

A gateway restart (`hermit gateway stop && hermit gateway start`) is required for plugin changes to take effect.

---

## 17.3 Adapter-Specific Notes

### Telegram

- One bot can serve one agent. If you want a second agent on Telegram, register a second bot.
- DMs work by default. Group chat support depends on the bot's privacy setting — see *Manage → Channels* for the toggle.
- Media: inbound photos/documents/video are uploaded to the agent (images become vision input) with captions kept as text, and voice notes are transcribed (replies are spoken back when TTS is configured); the agent can send media back. Inbound files over Telegram's ~20 MB Bot API download limit are skipped.

### Discord

- Bot applications are per agent.
- Slash commands optional; the agent works in plain channel chat once invited.
- Media: file/image attachments are uploaded to the agent (images become vision input) and audio attachments are transcribed; the agent can send files back. Attachments over 25 MiB are skipped.

### Slack

- Slack apps are workspace-scoped. Install per workspace, register per agent.
- Threading: the adapter creates a thread for each session by default. Quote-reply to continue an existing one.
- Media: shared files/images are uploaded to the agent (images become vision input) and audio files are transcribed; the agent can upload files back into the thread. Needs `files:read` + `files:write` scopes. Files over 25 MiB are skipped.

### WeChat (external plugin)

- Install with `hermit channel install @openhermit/channel-wechat`, then restart the gateway.
- Pair the bot through *Manage → Channels → Add channel → WeChat*: the UI renders a QR code that you scan with the WeChat mobile app and confirm. The setup wizard exchanges the scan + confirmation for a long-lived `bot_token` and IDC-pinned `base_url`, which the gateway stores on the channel row.
- Restarts preserve the login: the gateway reloads `bot_token` from the channel row and resumes the iLink long-poll without re-scanning. You only need to re-pair if you unlink the bot from inside the WeChat client.
- Media: inbound images are decrypted from the WeChat CDN and uploaded to the agent as vision input (over 25 MiB skipped). Inbound voice notes are decrypted, transcoded from SILK to WAV via `silk-wasm`, and transcribed via the agent's STT (WeChat's own transcript is used when present). Inbound file/video and all outbound media aren't handled yet. No group filtering.

### WhatsApp (external plugin)

- Install with `hermit channel install @openhermit/channel-whatsapp`, then restart the gateway.
- Pair through *Manage → Channels → Add channel → WhatsApp*: scan the QR code from WhatsApp → Linked devices.
- Baileys auth state is stored in encrypted DB channel credentials; the channel row keeps only `auth_profile` plus allow-list settings. Legacy `auth_dir` folders are no longer used.
- Media: inbound images/video/documents are uploaded as attachments (images become vision input) with captions kept as text; voice notes are transcribed via STT and replies spoken via TTS when voice is configured. The agent can send media back via `attachment_send`. Attachments over 25 MiB are skipped.

### Web / CLI

- No registration step. They are always on.

---

## 17.4 Identity Across Channels

When someone messages the agent via Telegram for the first time, the gateway records `(telegram, <telegram-user-id>) → user X`. Web sign-in similarly produces `(web, <web-uuid>) → user Y`. If X and Y are actually the same human, you link them — see [Chapter 14 · Managing Members](14-managing-members.md).

---

## 17.5 Role Differences

| | Owner | User | Guest |
|---|:---:|:---:|:---:|
| Configure channels | ✓ | — | — |
| Use channels the agent has | ✓ | ✓ | ✓ (if access level allows) |

---

## 17.6 How-to Recipes

### 17.6.1 Attach a Telegram bot to your agent

**Prerequisites**

1. Create a bot with BotFather; copy the bot token.
2. Save the token as an agent secret:

   ```bash
   hermit config --agent main secrets set TELEGRAM_BOT_TOKEN <token> --pass-through
   ```

**Steps**

Open *Manage → Channels*, choose the Telegram channel, enter the required bot token secret/config fields, and enable it. The same operation is available through `PATCH /api/agents/main/channels/<telegram-channel-id>`.

**Verify** — DM your bot; it replies.

**Common issues** — if it does not reply, check *Manage → Channels* for missing secrets or disabled status, then check the gateway logs.

---

### 17.6.2 Swap channels without losing memory

Channels are interchangeable surfaces over the same agent. Disable Telegram, enable Slack — memory, instructions, MCP tokens stay put. New sessions just come in over a different transport.

---

### 17.6.3 Run one bot for two agents

Not supported on the same channel handle. Use two distinct bot tokens / apps, one per agent.

---

### 17.6.4 Install a plugin channel (WeChat)

```bash
hermit channel install @openhermit/channel-wechat
hermit gateway stop && hermit gateway start
```

Then open *Manage → Channels → Add channel → WeChat*, scan the QR with your phone, confirm the login, and save the channel. To remove it later:

```bash
hermit channel uninstall @openhermit/channel-wechat
hermit gateway stop && hermit gateway start
```

`hermit channel list` shows what's currently registered.

---

## 17.7 FAQ

**Does using Telegram leak my data?** Messages traverse Telegram's servers. If you cannot send a piece of information through Telegram, do not send it through a Telegram-attached agent. Same logic for Slack, Discord.

**Can I delete a Telegram message that the agent replied in?** That is a Telegram client question, not OpenHermit. The session history in the gateway is unaffected by client-side deletes.

**Does the channel show in *Observe*?** Yes — each session is tagged with its source channel.

---

## 17.8 Pointers

- Tokens and credentials → [Chapter 18 · Secrets](18-secrets.md).
- Who can talk on each channel → [Chapter 13 · Access Levels](13-access-levels.md), [Chapter 15 · Policy and Approval](15-policy-and-approval.md).
- Identity linkage across channels → [Chapter 14 · Managing Members](14-managing-members.md).
