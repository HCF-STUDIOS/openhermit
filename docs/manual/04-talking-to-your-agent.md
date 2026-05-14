---
title: Talking to Your Agent
slug: talking-to-your-agent
order: 4
part: Part 2 — Daily Use
description: Five ways to reach your agent (CLI, Web, Telegram, Discord, Slack), how sessions work, and how to attach files, interrupt, and resume.
---

# 4. Talking to Your Agent

Your agent is one thing; the ways to reach it are several. This chapter walks through the five built-in channels, how a conversation is organized into a session, and the four day-to-day actions you will keep wanting: send, attach, interrupt, resume.

---

## 4.1 The Five Channels

| Channel | Best for | Set up in |
|---|---|---|
| **CLI** | Quick local chats, scripting, debugging | Works out of the box once `hermit` is installed |
| **Web** | Daily use from a browser, file uploads, browsing history | Started with `hermit web start` |
| **Telegram** | Mobile, on-the-go | [Chapter 17 · Channels](17-channels.md) |
| **Discord** | Community use, group servers | [Chapter 17 · Channels](17-channels.md) |
| **Slack** | Team use, threads, internal tools | [Chapter 17 · Channels](17-channels.md) |

All five reach the same agent — same memory, same skills, same configuration. The only thing that differs is how the conversation looks on your screen.

---

## 4.2 What a Session Is

Every conversation is a **session**: a thread of messages with an ID, participants, and a status. A session is created automatically the first time you message an agent through a particular conversation context (a Telegram chat, a Slack thread, an interactive CLI invocation, …).

Sessions persist. You can close one, walk away, and resume it later — the agent picks up where you left off. The agent's long-term memory survives across sessions, but a session's own scrollback is private to that session.

---

## 4.3 The CLI Channel

```bash
hermit chat --agent main
```

You get a prompt. Type, press Enter, the agent streams its reply. Useful flags:

```bash
hermit chat --agent main --session <id>     # resume a specific session
hermit chat --agent main --resume           # resume your most recent session
```

While inside `chat`, press **Ctrl-C** once to interrupt the current reply (the agent stops mid-stream but the session stays open). Press it twice to exit.

---

## 4.4 The Web Channel

```bash
hermit web start
```

Open the URL it prints (default `http://localhost:4310`; the gateway it talks to listens on `http://localhost:4000`). Pick an agent in the sidebar, pick or create a session, type your message.

The web channel has a few things the CLI does not:

- **File attachments** — drag a file onto the chat to upload it into the agent's workspace.
- **Session list** — every session you participated in, with previews.
- **Streaming with markdown rendering** — code blocks, tables, links render properly.
- **Tool call transcripts** — you can expand a step to see exactly what tool the agent called and what it got back.

---

## 4.5 Telegram, Discord, Slack

For these to work, the agent's owner has to connect a bot token first ([Chapter 17 · Channels](17-channels.md)).

Once connected:

- A **direct message** to the bot opens a session bound to your conversation.
- A **group / channel** message creates a group session including everyone who has posted (subject to access policy; see [Chapter 13 · Access Levels](13-access-levels.md)).
- Replying to a thread keeps you in that thread's session.

If you write to a freshly connected bot for the first time and the agent does not reply, you might be on the wrong side of [access levels](13-access-levels.md) — ask the owner to add you as a member.

---

## 4.6 Four Things You Will Do Constantly

**Send** — just type.

**Attach** — drag a file into the web UI, or in Telegram/Slack/Discord attach a file natively. The agent sees the file in its workspace and can open, edit, or refer to it.

**Interrupt** — sometimes the agent goes off on the wrong path. To stop it:

- CLI: **Ctrl-C** during the reply.
- Web: click the **Stop** button next to the streaming message.
- Telegram/Discord/Slack: send a follow-up like "stop" or "wait" — the runner accepts steering messages mid-turn and will fold them into the next step. Hard interrupt is not available on chat channels.

**Resume** — most channels resume automatically (you message the same Telegram chat → you are in the same session). For the CLI, use `--resume` or `--session <id>`.

---

## 4.7 Role Differences

The same channel can show different things to different people:

- **Owners** see every session for the agent.
- **Users** see only sessions they participate in.
- **Guests** see only the session(s) they are part of, and the agent has a reduced toolset for them (no exec, no file editing — see the matrix in [Chapter 5](05-users-and-identity.md#5-4-capability-matrix)).

If you log in expecting to see a session and it is missing, it is usually because your role does not allow it.

---

## 4.8 How-to Recipes

### 4.8.1 Resume a session you left yesterday

**Scenario** — you closed your laptop in the middle of a CLI chat; today you want to pick it up.

**Ways to do it**

CLI:

```bash
hermit chat --agent main --resume
```

That drops you back into the most recent session for that agent.

Web: open the agent in the web UI; the most recent session is at the top of the sidebar.

Telegram/Slack/Discord: just send a new message in the same chat or thread. The runner re-hydrates the session automatically.

**Verify** — the agent's first reply references something from yesterday's exchange.

---

### 4.8.2 Start a fresh session even though you are on the same channel

**Scenario** — you are in a Telegram DM with the agent, and you want to switch topics cleanly without dragging the previous thread's context along.

**Ways to do it**

- Telegram / Discord: tell the agent "let's start fresh" — it will not automatically open a new session, but for cleanliness you can ask the owner (via Web UI or CLI) to close the current one. New messages then open a new session.
- Web: click **New session** in the sidebar.
- CLI: exit (Ctrl-C twice) and re-run `hermit chat --agent main` without `--resume`.

**Verify** — the new session has no scrollback and the agent does not reference old context (but it may still recall things stored in long-term memory; that is a feature, not a bug — see [Chapter 6 · Memory](06-memory.md)).

---

### 4.8.3 Send a file and ask the agent about it

**Scenario** — you want the agent to read a CSV you have on disk.

**Ways to do it**

Web (easiest): drag the file into the chat window and type your question.

CLI: copy the file into the agent's workspace path first ([Chapter 10 · Files and Workspace](10-files-and-workspace.md)), then reference it by name in your message.

Telegram/Slack/Discord: send the file as an attachment in the chat. The adapter writes it into the workspace and the agent gets a notification it has arrived.

**Verify** — ask "what columns are in `<filename>`?" — the agent should answer with the actual headers.

---

### 4.8.4 Interrupt a reply that is going the wrong way

**Scenario** — the agent has started doing the wrong thing (writing the wrong file, going down the wrong reasoning path) and you want to stop it before it finishes.

**Ways to do it**

- CLI/Web: hit the stop control mid-stream.
- Chat channels: send a one-line correction. The runner queues it as a *steering message* — it is inserted into the conversation before the agent's next step, so the agent reads your correction and changes direction.

**Verify** — the agent acknowledges the change of direction in its next reply.

---

## 4.9 Pointers

- Connect a new channel: [Chapter 17 · Channels](17-channels.md).
- Manage who can use this agent: [Chapter 12 · Inviting People](12-inviting-people.md).
- Why the agent forgets / does not forget across sessions: [Chapter 6 · Memory](06-memory.md).
