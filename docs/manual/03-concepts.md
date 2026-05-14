---
title: Core Concepts
slug: concepts
order: 3
part: Part 1 — Getting Started
description: The seven words you will see in every chapter — agent, session, channel, skill, MCP server, memory, workspace.
---

# 3. Core Concepts

Seven words make up the vocabulary used in every later chapter. Read this once and most of the rest of the manual reads naturally.

---

## 3.1 Agent

An **agent** is the persistent "it" that replies to you. From your side, it is a name (`main`, `work`, `home`) attached to:

- a configured **model** (which LLM it thinks with),
- a set of **skills** and **MCP servers** (what it can do),
- a **workspace** (what files it can touch),
- **memory** and **instructions** (what it remembers and what rules it follows),
- a list of **members** (who is allowed to talk to it and what they can do).

One OpenHermit instance can host many agents. They are isolated: different memories, different configuration, different access lists.

---

## 3.2 Session

A **session** is a single conversation. It has a history of messages, an ID, a list of participants, and a status (active or closed).

You can have many sessions with the same agent in parallel — one per topic, one per channel, one per project, however you like to organize. Closing a session does not erase it; you can resume it later. The agent's long-term memory persists across sessions, but a session's own message history belongs only to that session.

In channels like Telegram or Slack, a session usually corresponds to a chat or a thread.

---

## 3.3 Channel

A **channel** is how messages reach the agent. OpenHermit ships with five:

| Channel | What it is |
|---|---|
| **CLI** | The `hermit chat` terminal. |
| **Web** | Browser-based chat at the admin UI. |
| **Telegram** | A Telegram bot you connect with a bot token. |
| **Discord** | A Discord bot (gateway connection). |
| **Slack** | A Slack app (socket mode). |

The same agent can be reachable on several channels at once. Sessions stay isolated per conversation; memory and configuration are shared.

---

## 3.4 Skill

A **skill** is a packaged capability you can turn on for an agent — a `SKILL.md` plus any supporting files (scripts, prompts, references). Examples: *standup-digest*, *web-research*, *postgres-explorer*.

Skills come in two flavours: **built-in** (ship with OpenHermit) and **workspace** (you register yourself from a local folder). Either way, enabling a skill for an agent makes its instructions and tools available; disabling hides them again.

You control skills with the `hermit skills` family of commands or in the Web admin UI's *Skills* tab.

---

## 3.5 MCP Server

An **MCP server** is an external tool provider — anything from GitHub or Slack to your own internal API — that speaks the [Model Context Protocol](https://modelcontextprotocol.io). Connecting an MCP server lets your agent call its tools as part of normal conversation.

MCP servers are registered globally with OpenHermit and enabled per agent (or fleet-wide). Day-to-day: `hermit mcp` or the *MCP* tab in the admin UI.

---

## 3.6 Memory

**Memory** is what the agent keeps across sessions. Three layers:

- **Session history** — every message in a session. Naturally local to that session.
- **Working memory** — short-lived notes the agent keeps inside one session (e.g. "the user wants this report in markdown").
- **Long-term memory** — entries persisted in the database, searchable across sessions. This is where preferences, facts, and learned patterns live.

You teach long-term memory mostly by talking: "remember that I am vegetarian", "remember that our staging URL is …". You can also read and curate it through the admin UI. [Chapter 6 · Memory](06-memory.md) goes deep.

---

## 3.7 Workspace

The **workspace** is the agent's "computer" — a filesystem it can read and write inside a sandbox. Each agent has its own workspace, isolated from others.

This is where uploaded files land, where the agent saves generated artefacts, where it clones a repo if you ask it to. The workspace is **shared across sessions** for one agent: a file you uploaded in one chat is visible to the agent in the next.

The sandbox can be a local Docker container, an E2B cloud sandbox, or a Daytona workspace, depending on how the instance was set up. That choice is operator-side; from your seat, the workspace just looks like the agent's hard drive. Details in [Chapter 10 · Files and Workspace](10-files-and-workspace.md).

---

## 3.8 How They Fit Together

A rough picture:

```
  ┌─────────────────────────── Agent: "main" ─────────────────────────┐
  │                                                                   │
  │   ┌──────────┐    ┌──────────┐    ┌──────────┐                    │
  │   │ Sessions │    │  Memory  │    │ Instr's  │                    │
  │   └──────────┘    └──────────┘    └──────────┘                    │
  │                                                                   │
  │   ┌──────────┐    ┌──────────┐    ┌──────────┐                    │
  │   │  Skills  │    │   MCP    │    │ Workspace│                    │
  │   └──────────┘    └──────────┘    └──────────┘                    │
  │                                                                   │
  └───────────────────────────────┬───────────────────────────────────┘
                                  │
       ┌────────────┬─────────────┼─────────────┬────────────┐
     CLI         Web UI      Telegram         Discord       Slack
```

You reach the agent through any **channel**. Inside a channel, each conversation is a **session**. The agent draws on **memory**, **instructions**, **skills**, **MCP servers**, and its **workspace** to do work. **Members** (you and anyone else you invited) each have a role that decides what they can ask the agent to do.

That is the whole picture. Every later chapter is a closer look at one of these boxes.
