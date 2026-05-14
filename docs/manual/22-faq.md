---
title: FAQ
slug: faq
order: 22
part: Part 5 — Reference
description: The questions people ask most often, with short answers.
---

# 22. FAQ

Short answers to the questions that come up most. Deeper detail is always in the chapter the question links to.

---

**What is the difference between an agent and a session?**
An agent is the persistent thing — its memory, instructions, skills, MCPs. A session is a single conversation with it. The agent outlives any session. → [Chapter 3](03-concepts.md).

**Can two people share one agent?**
Yes. They each get an identity tied to the channel they use, and the owner controls roles. Memory is shared per agent. → [Chapter 5](05-users-and-identity.md).

**How do I keep my private memory private from other users on the same agent?**
You cannot, on one agent. Memory is per-agent, not per-user. For per-user privacy, run one agent per user. → [Chapter 6](06-memory.md).

**Instructions vs memory — which when?**
Instructions for rules that must hold every session. Memory for facts and preferences the agent can recall when relevant. → [Chapter 7](07-instructions.md).

**Skills vs MCP servers — which when?**
Skills package prompting patterns and helper scripts. MCP servers connect external systems. Use both together when you need to. → [Chapter 8](08-skills.md) and [Chapter 9](09-mcp-servers.md).

**Can the agent execute code in its environment?**
Yes — via the `exec` tool, inside its sandboxed workspace. By default owners and users have it; guests do not. → [Chapter 10](10-files-and-workspace.md).

**Will switching models lose my memory or sessions?**
No. Model is a runtime choice; storage is independent. → [Chapter 16](16-models.md).

**How do I stop a runaway turn?**
Hit interrupt (Ctrl-C in CLI, the stop button in web). The runner also aborts after 15 consecutive tool failures on its own.

**Can the agent message me on its own?**
Through schedules, yes. The schedule's prompt tells it where to send the result. → [Chapter 11](11-schedules.md).

**Is OpenHermit open source?**
Yes. The exact repo and licence are operator-known.

**How do I share an agent with someone outside my company?**
Set access level to public or protected, share the URL or channel handle. → [Chapter 12](12-inviting-people.md), [Chapter 13](13-access-levels.md).

**How do I make a guest into a user?**
Use the gateway admin UI's *Users* tab, or ask the agent as owner to promote the user. → [Chapter 14](14-managing-members.md).

**Does the agent remember everything I say forever?**
Long-term memory entries persist until you delete them. Session scrollback is per session. → [Chapter 6](06-memory.md).

**Where are my files stored?**
In the agent's workspace, on the gateway. Persistent across restarts. → [Chapter 10](10-files-and-workspace.md).

**Can I trust the agent with credentials?**
Put credentials in the secret store. The agent uses them via tools but does not see raw values in its context. → [Chapter 18](18-secrets.md).

**What if a tool the agent wants to call is dangerous?**
Policy + approval. Mark the tool as `require_approval`; the owner gets a prompt before the call runs. → [Chapter 15](15-policy-and-approval.md).

**Can I run OpenHermit locally?**
Yes — the gateway runs on a single host or in a container. Operator territory beyond that.

**Where do I report bugs or request features?**
Ask your operator or check the project repo. The gateway logs are the first thing they will ask for.

---

## 22.1 Pointers

- Symptom-first issues → [Chapter 21 · Troubleshooting](21-troubleshooting.md).
- Vocabulary cheatsheet → [Chapter 23 · Glossary](23-glossary.md).
