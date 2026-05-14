---
title: Glossary
slug: glossary
order: 23
part: Part 5 — Reference
description: Short definitions for every term used in this manual.
---

# 23. Glossary

Plain-language definitions, alphabetical. Each term points at the chapter where it is treated in full.

---

**Access level.** Public, protected, or private — the gate that decides who can start a session at all. → [Ch. 13](13-access-levels.md).

**Adapter.** Code that plugs a channel into the gateway. There is a Telegram adapter, a Slack adapter, and so on. → [Ch. 17](17-channels.md).

**Agent.** The persistent thing — model + instructions + memory + skills + MCP connections + workspace. The unit you configure and share. → [Ch. 3](03-concepts.md).

**Approval.** A policy effect that pauses a tool call until the owner says yes or no. → [Ch. 15](15-policy-and-approval.md).

**Channel.** A transport for messages: CLI, web, Telegram, Discord, Slack. → [Ch. 17](17-channels.md).

**Cron.** Recurring schedule expression. → [Ch. 11](11-schedules.md).

**Effect.** What a policy rule does: allow, deny, or require_approval. → [Ch. 15](15-policy-and-approval.md).

**Gateway.** The OpenHermit server. Runs your agents, holds their data, exposes the web UI and APIs.

**Guest.** Lowest-privilege role. Read-only by default, no memory writes, no exec. → [Ch. 5](05-users-and-identity.md).

**Identity.** A tuple of `(channel, channel_user_id)` resolving to one user record. A user can have several. → [Ch. 5](05-users-and-identity.md).

**Instructions.** Rules pinned to the agent's system prompt. Owner-only. → [Ch. 7](07-instructions.md).

**MCP (Model Context Protocol).** Standard for exposing external tools to an agent. → [Ch. 9](09-mcp-servers.md).

**Memory.** Facts and preferences the agent stores and recalls. Three layers: session, working, long-term. → [Ch. 6](06-memory.md).

**Model.** The LLM driving the agent's replies. Swap-able without losing memory. → [Ch. 16](16-models.md).

**Observe.** The web UI tab for read-only inspection of agent activity. → [Ch. 20](20-web-admin-ui.md).

**Owner.** Top-privilege role. Manages users, policy, secrets, instructions. → [Ch. 5](05-users-and-identity.md).

**Policy.** Per-tool rules layered below role. → [Ch. 15](15-policy-and-approval.md).

**Role.** Owner, user, or guest. Determines default capability. → [Ch. 5](05-users-and-identity.md).

**Sandbox.** The isolated environment in which the agent's workspace lives — Docker, E2B, Daytona, depending on operator choice. → [Ch. 10](10-files-and-workspace.md).

**Schedule.** A saved prompt that fires on cron or at a one-off time. → [Ch. 11](11-schedules.md).

**Secret.** A named credential stored separately from configs and substituted at runtime. → [Ch. 18](18-secrets.md).

**Session.** One conversation with the agent. → [Ch. 3](03-concepts.md), [Ch. 4](04-talking-to-your-agent.md).

**Skill.** A folder with a `SKILL.md` and optional helpers that extends what the agent can do. → [Ch. 8](08-skills.md).

**Tool.** A function the agent can call — file read/write, exec, MCP-exposed APIs, memory ops, etc.

**User.** Standard role between guest and owner. Full chat + tools, no admin. → [Ch. 5](05-users-and-identity.md).

**Workspace.** The agent's filesystem inside its sandbox. → [Ch. 10](10-files-and-workspace.md).

---

## 23.1 Pointers

- Start at the top → [Chapter 1 · What OpenHermit Is](01-introduction.md).
- Or jump to the chapter that matches what you are trying to do → [README](README.md).
