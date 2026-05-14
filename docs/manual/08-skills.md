---
title: Skills
slug: skills
order: 8
part: Part 2 — Daily Use
description: What skills are, how to enable and disable them, where they come from, and how to register your own.
---

# 8. Skills

A **skill** is a packaged capability you can switch on for an agent. Think of it as a small folder with a `SKILL.md` that explains the capability and any scripts or templates that go with it. Skills are the easiest way to extend what an agent can do without writing code.

This chapter walks through enabling, disabling, and registering skills, and points at how skills relate to MCP servers (Chapter 9).

---

## 8.1 What a Skill Looks Like

At minimum, a skill is a directory with:

```
my-skill/
├── SKILL.md         # description, when to use, instructions
└── (optional helpers — scripts, prompt fragments, references)
```

The `SKILL.md` frontmatter carries metadata:

```markdown
---
name: standup-digest
description: Summarises the team's standup updates into a daily digest.
---

# Standup digest

Use this skill when the user asks for a daily standup summary…
```

When you enable a skill for an agent, the agent gets the `SKILL.md` content as additional context and access to any helper scripts in the skill folder.

---

## 8.2 Two Sources of Skills

**Built-in skills.** Ship with OpenHermit and are discoverable as soon as the gateway is running. They cover common patterns: research, summarisation, GitHub helpers, and similar.

**User skills.** Skills you write yourself, or pull from a third-party repo. Drop the skill folder under `~/.openhermit/skills/user/` and the gateway picks it up on the next scan. Once registered, user skills behave the same as built-in skills.

```
~/.openhermit/skills/user/
├── weekly-retro/
│   └── SKILL.md
├── standup-digest/
│   ├── SKILL.md
│   └── helper.sh
└── …
```

Either source — built-in or user — the workflow is identical: list, enable, disable.

---

## 8.3 The `hermit skills` Commands

```bash
# List skills registered with this instance.
hermit skills list

# List which skills are enabled on which agents.
hermit skills assignments

# Scan the gateway's skill directory for new skills.
hermit skills scan

# Register a new skill (reads SKILL.md frontmatter).
hermit skills register my-skill --path ./skills/my-skill

# Enable a skill for one agent.
hermit skills enable standup-digest --agent main

# Enable for every agent in the fleet.
hermit skills enable standup-digest --all

# Disable for an agent.
hermit skills disable standup-digest --agent main

# Remove a skill from the registry entirely.
hermit skills delete my-skill
```

Enabling a skill is **idempotent** — running enable twice does nothing the second time.

---

## 8.4 How the Agent Uses an Enabled Skill

Two things happen when a skill is enabled:

- The skill's `SKILL.md` body is included in the agent's system prompt under a recognisable header.
- Helper scripts in the skill folder are reachable from the workspace, so the agent can execute them.

The agent decides on its own when a skill applies. You usually do not need to invoke it by name; just say what you want ("write me the standup digest for today") and the agent picks the right skill from the descriptions.

---

## 8.5 Web Admin UI

The *Manage → Skills* tab shows the registry, the assignments, and toggles to enable or disable per agent. Registering new skills typically still happens through the filesystem — drop the folder under `~/.openhermit/skills/user/` and run `hermit skills scan` (or restart the gateway).

---

## 8.6 Role Differences

| | Owner | User | Guest |
|---|:---:|:---:|:---:|
| Use an enabled skill | ✓ | ✓ | ✓ (if the skill's tools are allowed for them) |
| Enable / disable skills | ✓ | — | — |
| Register / delete skills | ✓ | — | — |

Users and guests can benefit from skills the owner has enabled; they cannot enable new ones.

---

## 8.7 How-to Recipes

### 8.7.1 Turn on a built-in skill

**Scenario** — you want to add the `web-research` capability to your `main` agent.

```bash
hermit skills list                       # confirm it is present
hermit skills enable web-research --agent main
```

**Verify** — ask the agent "research the latest news about X and summarise" — it should use the skill's pattern.

---

### 8.7.2 Write and register your own skill

**Scenario** — you have a recurring pattern (say, weekly retro generation) and you want to package it.

**Steps**

1. Create the folder under the user skills directory:

   ```bash
   mkdir -p ~/.openhermit/skills/user/weekly-retro
   ```

2. Write `SKILL.md` inside it:

   ```markdown
   ---
   name: weekly-retro
   description: Generates a weekly retrospective from the past 7 days of sessions.
   ---

   # Weekly retro

   When asked for a weekly retro, …
   ```

3. Scan and enable:

   ```bash
   hermit skills scan
   hermit skills enable weekly-retro --agent main
   ```

**Verify** — `hermit skills list` shows the new entry; `hermit skills assignments` shows it enabled for `main`.

---

### 8.7.3 Roll a skill out to every agent

```bash
hermit skills enable critique --all
```

**Verify** — `hermit skills assignments` shows the skill enabled on every agent.

---

### 8.7.4 Disable a skill you no longer want

```bash
hermit skills disable old-skill --agent main
```

Or fleet-wide:

```bash
hermit skills disable old-skill --all
```

This does not delete the skill from the registry; it just stops it from being available on the selected agents. To delete entirely: `hermit skills delete old-skill`.

---

## 8.8 FAQ

**Do skills cost tokens?** Yes — an enabled skill's `SKILL.md` is part of the system prompt. Long skill descriptions raise the per-turn token cost. Keep skill docs concise.

**Skills vs MCP servers — when do I pick which?** Skills package *prompting patterns and small helper scripts*. MCP servers package *external systems exposed as tools*. If you want "always do X this way", that is a skill. If you want "be able to call GitHub", that is an MCP server.

**Can a skill require an MCP server?** Yes — a skill's prompt can assume specific MCP tools exist. Document that requirement in the `SKILL.md` so users know to enable both.

**How does the agent pick which skill to use?** It reads each enabled skill's description in the system prompt and matches against the request. Descriptions matter — write them like search queries.

---

## 8.9 Pointers

- External tool integrations → [Chapter 9 · MCP Servers](09-mcp-servers.md).
- The full list of skills shipping with OpenHermit → run `hermit skills list` on your instance.
- Restricting which roles can invoke a particular skill's tools → [Chapter 15 · Policy and Approval](15-policy-and-approval.md).
