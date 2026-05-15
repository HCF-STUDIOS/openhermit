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

- **CLI** — `hermit chat`. Always available if you have the CLI installed.
- **Web** — `https://<your-gateway>/chat/<agent>`. Always available once the gateway is reachable.
- **Telegram** — bot you create via BotFather, registered with the agent.
- **Discord** — bot application registered with the agent.
- **Slack** — Slack app installed into your workspace, registered with the agent.

Each non-CLI channel needs a credential (a bot token or app secret). Credentials are stored as secrets — see [Chapter 18](18-secrets.md).

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
- Attachments (files, images) flow into the workspace under the uploads path.

### Discord

- Bot applications are per agent.
- Slash commands optional; the agent works in plain channel chat once invited.

### Slack

- Slack apps are workspace-scoped. Install per workspace, register per agent.
- Threading: the adapter creates a thread for each session by default. Quote-reply to continue an existing one.
- File attachments supported.

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

## 17.7 FAQ

**Does using Telegram leak my data?** Messages traverse Telegram's servers. If you cannot send a piece of information through Telegram, do not send it through a Telegram-attached agent. Same logic for Slack, Discord.

**Can I delete a Telegram message that the agent replied in?** That is a Telegram client question, not OpenHermit. The session history in the gateway is unaffected by client-side deletes.

**Does the channel show in *Observe*?** Yes — each session is tagged with its source channel.

---

## 17.8 Pointers

- Tokens and credentials → [Chapter 18 · Secrets](18-secrets.md).
- Who can talk on each channel → [Chapter 13 · Access Levels](13-access-levels.md), [Chapter 15 · Policy and Approval](15-policy-and-approval.md).
- Identity linkage across channels → [Chapter 14 · Managing Members](14-managing-members.md).
