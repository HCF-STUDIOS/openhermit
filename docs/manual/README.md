---
title: OpenHermit User Manual
slug: /
order: 0
---

# OpenHermit User Manual

This is the user manual for OpenHermit. It is written for **people who have an OpenHermit agent and want to use it** — whether you run it alone or share it with a small team.

If you are looking for how to deploy, operate, or extend OpenHermit itself, that material lives in the rest of `docs/` and is out of scope here.

---

## Contents

### Part 1 — Getting Started

1. [What OpenHermit Is](01-introduction.md)
2. [Quickstart](02-quickstart.md)
3. [Core Concepts](03-concepts.md)

### Part 2 — Daily Use

4. [Talking to Your Agent](04-talking-to-your-agent.md)
5. [Users and Identity](05-users-and-identity.md)
6. [Memory](06-memory.md)
7. [Instructions](07-instructions.md)
8. [Skills](08-skills.md)
9. [MCP Servers](09-mcp-servers.md)
10. [Files and Workspace](10-files-and-workspace.md)
11. [Schedules](11-schedules.md)

### Part 3 — Sharing Your Agent

12. [Inviting People](12-inviting-people.md)
13. [Access Levels](13-access-levels.md)
14. [Managing Members](14-managing-members.md)
15. [Policy and Approval](15-policy-and-approval.md)

### Part 4 — Customizing (owner-only)

16. [Models](16-models.md)
17. [Channels](17-channels.md)
18. [Secrets](18-secrets.md)

### Part 5 — Reference

19. [CLI Cheatsheet](19-cli-cheatsheet.md)
20. [Web Admin UI Tour](20-web-admin-ui.md)
21. [Troubleshooting](21-troubleshooting.md)
22. [FAQ](22-faq.md)
23. [Glossary](23-glossary.md)

---

## How to Read This Manual

- **First time with OpenHermit** — read Part 1 in order (about 15 minutes). You will have an agent up and answering messages by the end.
- **Already using it, want to do something specific** — jump to the chapter that matches. Each chapter ends with **How-to recipes** that follow a fixed shape: *scenario → prerequisites → ways to do it → verify → common issues*.
- **Planning to share your agent with others** — Part 3 is written for you.
- **Stuck** — start with [Troubleshooting](21-troubleshooting.md) and the [FAQ](22-faq.md).

---

## Conventions

- **Bold terms** mark concepts on first appearance; each has a one-line definition in the [Glossary](23-glossary.md).
- **Role markers**: actions that only the agent owner can take are tagged *(owner-only)*. The full capability table is in [Chapter 5 · Users and Identity](05-users-and-identity.md).
- **Command prefixes**:
  - `hermit …` — CLI command
  - `curl …` — HTTP API call
  - *Admin UI:* `path → action` — Web admin operation
