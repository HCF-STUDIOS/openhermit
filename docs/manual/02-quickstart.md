---
title: Quickstart
slug: quickstart
order: 2
part: Part 1 — Getting Started
description: Install the CLI, create your first agent, and send a first message — in about ten minutes.
---

# 2. Quickstart

This chapter takes you from nothing to a working agent in about ten minutes. You will install the CLI, start a local gateway, create an agent, send a message, and learn the three or four commands you will use every day.

---

## 2.1 Prerequisites

You need:

- **Node.js 20 or newer** — check with `node --version`.
- **A PostgreSQL database** — local Postgres, Docker Postgres, or a managed Postgres URL.
- **At least one model provider API key** — Anthropic, OpenAI, or OpenRouter.

If you do not have Postgres handy, the `docker-compose.yml` at the root of the repo brings one up:

```bash
docker compose up -d postgres
```

---

## 2.2 Install the CLI

```bash
npm install -g openhermit
```

This installs the `hermit` command. Confirm it works:

```bash
hermit --version
```

---

## 2.3 Run the Setup Wizard

The fastest path is the interactive wizard. It walks through the database URL, the model provider, and the first agent in one pass.

```bash
hermit setup
```

When the wizard asks for things:

- **Postgres URL** — for example `postgres://postgres:postgres@localhost:5432/openhermit`.
- **Provider** — `anthropic`, `openrouter`, or `openai`.
- **API key** — paste the key you got from your provider.
- **First agent ID** — pick something short, like `main`.

The wizard creates the gateway config, runs database migrations, and starts the gateway in the background.

---

## 2.4 Verify the Setup

```bash
hermit doctor
```

`doctor` checks that the gateway is up, the database is reachable, your API key works, and your agent is registered. If it complains, the error tells you which piece is wrong.

```bash
hermit status
```

`status` gives you a one-screen overview: which agents exist, whether each is enabled, and which channels are connected.

---

## 2.5 Send Your First Message

Two ways.

**From the terminal** — open an interactive chat:

```bash
hermit chat --agent main
```

You will see a prompt. Type a message and press Enter. The agent streams its reply.

**From the web UI** — start the web server:

```bash
hermit web start
```

It tells you a URL (default `http://localhost:4310`). Open it in a browser, pick your agent, and chat. The gateway itself listens on `http://localhost:4000`.

Either way, the conversation is stored as a **session** and persists across restarts.

---

## 2.6 The Five Commands You Will Use Most

These are the commands worth learning today:

| Command | What it does |
|---|---|
| `hermit status` | One-screen overview of agents, channels, gateway state. |
| `hermit chat --agent <id>` | Open an interactive chat with an agent. |
| `hermit logs -f` | Tail the gateway log; useful when something feels stuck. |
| `hermit config show --agent <id>` | Print the current configuration for an agent. |
| `hermit agents list` | List all agents in this instance. |

Full command reference: [Chapter 19 · CLI Cheatsheet](19-cli-cheatsheet.md).

---

## 2.7 What Now

You have a working agent. Some natural next steps:

- **Understand what just happened** — [Chapter 3 · Core Concepts](03-concepts.md) explains the words *agent*, *session*, *channel*, *skill*, *workspace*.
- **Connect Telegram or Slack** — [Chapter 17 · Channels](17-channels.md).
- **Let someone else use this agent** — [Chapter 12 · Inviting People](12-inviting-people.md).
- **Teach the agent persistent rules** — [Chapter 7 · Instructions](07-instructions.md).
- **Give it a scheduled job** — [Chapter 11 · Schedules](11-schedules.md).
