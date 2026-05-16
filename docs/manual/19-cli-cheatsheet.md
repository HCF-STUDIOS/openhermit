---
title: CLI Cheatsheet
slug: cli-cheatsheet
order: 19
part: Part 5 — Reference
description: Every `hermit` command on one page, grouped by what you are trying to do.
---

# 19. CLI Cheatsheet

A flat reference, grouped by job. Run `hermit <command> --help` for full options on any subcommand.

---

## 19.1 Basics

```bash
hermit setup                        # first-time wizard
hermit chat                         # interactive REPL with the default agent
hermit chat --agent <id>            # specific agent
hermit chat --agent <id> --resume   # resume the latest CLI session
```

---

## 19.2 Agents

```bash
hermit agents list
hermit agents create <id> --name "<name>" --workspace-dir <path>
hermit agents enable  <id>
hermit agents disable <id>
hermit agents restart <id>
hermit agents delete  <id>

# Configuration is its own command tree (no `hermit agents update`):
hermit config --agent <id> show
hermit config --agent <id> get <key>
hermit config --agent <id> set <key> <value>

# Common keys:
#   model.provider           anthropic | openai | openrouter | …
#   model.model              <provider-specific model id>
#   model.max_tokens         <int>
hermit config --agent <id> security set access public|protected|private
```

---

## 19.3 Users (Members)

There is no `hermit users` command in the current CLI. Manage members through the web admin Users panel, the `/api/agents/<id>/members` API, or the owner-only agent tools (`user_list`, `user_role_set`, `user_identity_link`, `user_identity_unlink`, `user_merge`).

---

## 19.4 Instructions

```bash
hermit instructions list   [--agent <id>|--all]
hermit instructions get    <key> --agent <id>
hermit instructions set    <key> "<text>"      [--agent <id>|--all]
hermit instructions set    <key> --file <path> [--agent <id>|--all]
hermit instructions append <key> "<text>"      [--agent <id>|--all]
hermit instructions remove <key>               [--agent <id>|--all]
```

---

## 19.5 Skills

```bash
hermit skills list
hermit skills assignments
hermit skills scan
hermit skills register <name> --path <dir>
hermit skills enable  <name> [--agent <id>|--all]
hermit skills disable <name> [--agent <id>|--all]
hermit skills delete  <name>
```

---

## 19.6 MCP Servers

```bash
hermit mcp list
hermit mcp assignments
hermit mcp enable  <name> [--agent <id>|--all]
hermit mcp disable <name> [--agent <id>|--all]
```

---

## 19.7 Channels

```bash
hermit channel install   <pkg>    # npm install -g <pkg> + add to channelPackages
hermit channel uninstall <pkg>    # remove from channelPackages + npm uninstall -g <pkg>
hermit channel list
```

Restart the gateway after install/uninstall. Per-agent channel config (enabling Telegram, issuing webhook tokens, etc.) lives in *Manage → Channels* or under `/api/agents/<id>/channels`.

---

## 19.8 Schedules

```bash
hermit schedules create --type cron --cron "<expr>" --prompt "<text>" --agent <id>
hermit schedules create --type once --run-at "<iso>" --prompt "<text>" --agent <id>
hermit schedules list   --agent <id>
hermit schedules pause  <id> --agent <id>
hermit schedules resume <id> --agent <id>
hermit schedules delete <id> --agent <id>
hermit schedules runs   <id> --agent <id>
```

---

## 19.9 Secrets

```bash
hermit config --agent <id> secrets list
hermit config --agent <id> secrets set    <KEY> <value> [--pass-through|--no-pass-through]
hermit config --agent <id> secrets remove <KEY>
```

---

## 19.10 Policy

```bash
hermit config --agent <id> policy list
hermit config --agent <id> policy set <resource-key> '<grants-json>' --effect allow|deny|require_approval
hermit config --agent <id> policy delete <resource-key> [--effect allow|deny|require_approval]
hermit config --agent <id> approvals list [--status pending|approved|rejected|expired]
hermit config --agent <id> approvals review <request-id> approved|rejected
```

---

## 19.11 Help and Diagnostics

```bash
hermit --help
hermit <command> --help
hermit doctor                     # connection + auth sanity check
hermit --version
```

---

## 19.12 `--all` vs `--agent`

Most write commands accept either:

- `--agent <id>` — operate on one agent.
- `--all` — operate on every agent on this instance.

Read commands (`list`, `get`) usually require `--agent` to scope; if omitted they may default to the configured default agent.

---

## 19.13 Pointers

- Why each command exists → the relevant chapter (Instructions = 7, Skills = 8, etc.).
- Web equivalents → [Chapter 20 · Web Admin UI](20-web-admin-ui.md).
