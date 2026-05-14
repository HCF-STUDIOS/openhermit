---
title: What OpenHermit Is
slug: introduction
order: 1
part: Part 1 — Getting Started
description: What OpenHermit is, what problem it solves, what it is good at, and what it is not good at.
---

# 1. What OpenHermit Is

OpenHermit is **a platform for running AI agents**. You give it a model (Claude, GPT, Gemini, …) and connect it to the places you already talk — Telegram, Discord, Slack, the web, the command line — and your agent then lives in the cloud as a long-running service. You send it a message, it replies. You ask it to run a command, it runs one. You tell it to file a report every weekday morning, it files one every weekday morning.

The main difference from local agents like Claude Code or Cursor is that **OpenHermit is not tied to a single machine**. It has a persistent identity in the cloud — memories, sessions, skills, configuration, scheduled jobs — and any entry point you use sees the same agent.

This manual is for people who already have an OpenHermit agent. Setting up a new OpenHermit instance is a different topic and lives in the operator docs.

---

## What It Solves

If you have used Claude Code or similar local tools, you have probably hit some of these:

- You taught the agent your preferences on your work laptop, then on your home laptop it remembered nothing.
- You wanted the agent to run a job overnight, but your laptop sleeps.
- You wanted a friend to use your agent, but its memory and history are tied to your machine.
- You wanted to reach the agent from Telegram or Slack instead of a terminal, and configuring a bridge turned into a side project.

OpenHermit's design starts from those problems. The agent has durable cloud-side state, multiple entry points reach the same agent, multiple people can share an agent with proper isolation, and the agent keeps working while you are offline.

---

## What You Can Use It For

- **Personal assistant** — remembers your preferences and tasks, reachable from phone or laptop, sends you scheduled reminders or digests.
- **Shared team assistant** — a few people share one agent: a shared knowledge base, daily standup summaries, customer support triage.
- **Vertical chatbot** — drop it into a Telegram or Discord group to serve a community around a specific topic.
- **Background worker** — scheduled jobs to pull data, scrape, write daily reports, check on services.
- **MCP-driven automation** — connect GitHub, Linear, Slack, or your own internal APIs as MCP tools, then operate them in natural language.

---

## What It Is Not Good At

- **Fully offline work.** OpenHermit assumes a gateway is reachable. For air-gapped environments, a local-only tool is a better fit.
- **Massive end-user SaaS.** You can build on it, but rate limits, billing, abuse handling — those are still your job.
- **Replacing an IDE.** It can write code, edit files, and run commands, but it is not VS Code. Code editing inside an IDE is still smoother.
- **Acting as an unrestricted root.** By default it can touch its workspace and run sandboxed commands; reaching the outside world needs MCP servers or secrets that you provision. It is not free to do anything.

---

## Two Words You Will See Throughout

Even if you are the only person using your agent, two terms are worth holding onto:

- **Agent** — the "it" that replies to you. An OpenHermit instance can host multiple agents (say, one named *work* and one named *home*) that share nothing — memories, configuration, and access lists are all independent.
- **You as owner** — you created the agent, so you are its **owner**. Owners can change settings, add members, see every session, and use every tool. Anyone else you invite gets a more restricted role: *user* or *guest*. The details are in [Chapter 5 · Users and Identity](05-users-and-identity.md).

---

## Where to Go Next

- Want to get something running first: [Chapter 2 · Quickstart](02-quickstart.md).
- Want to read concepts before touching anything: [Chapter 3 · Core Concepts](03-concepts.md).
- Already using it, looking for a specific recipe: open the relevant chapter and scroll to its *How-to recipes* section.
