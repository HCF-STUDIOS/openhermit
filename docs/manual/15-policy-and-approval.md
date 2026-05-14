---
title: Policy and Approval
slug: policy-and-approval
order: 15
part: Part 3 — Sharing an Agent
description: Per-tool rules that allow, deny, or require approval — the fine-grained layer below role.
---

# 15. Policy and Approval

Role gives a coarse split (guest / user / owner). **Policy** is the layer underneath that lets you say "users can call `exec`, but only for read-only commands", or "any tool that touches the GitHub MCP server needs my approval first". Policy is how you make a shared agent safe.

---

## 15.1 The Three Effects

Every policy rule produces one of three outcomes when the agent is about to call a tool:

- **Allow** — the call proceeds.
- **Deny** — the call is blocked; the agent receives an error in place of the result and decides what to do next.
- **Require approval** — the call pauses; the owner gets a notification with the tool name and arguments, and must approve or reject before it runs.

When multiple rules match, the most restrictive wins.

---

## 15.2 What a Rule Looks At

A rule can match on:

- **Tool name / resource** — `file_write`, `exec`, or an MCP server id such as `github`.
- **Tool argument patterns** — e.g., `exec` where the command begins with `rm`.
- **Principal role** — guest / user / owner.
- **Resource path** — for file tools, the path the tool would touch.
- **Channel** — sometimes useful to allow more in CLI/web than in public Telegram.

Rules compose. You usually start with a couple of broad defaults and add specific exceptions as you encounter them.

---

## 15.3 The `hermit config policy` Commands

```bash
# List rules on an agent.
hermit config --agent main policy list

# Deny guests access to exec.
hermit config --agent main policy set exec '[{"type":"role","value":"guest"}]' --effect deny

# Require approval for users on a GitHub MCP server.
hermit config --agent main policy set github '[{"type":"role","value":"user"}]' --resource-type mcp --effect require_approval

# Remove a rule.
hermit config --agent main policy delete exec --effect deny
```

`<resource-key>` is usually a tool name such as `exec`, an MCP server id such as `github`, or `*`. Grants are a JSON array such as `[{"type":"role","value":"guest"}]`, `[{"type":"role","value":"user"}]`, or `[{"type":"any"}]`.

---

## 15.4 Approvals — The User Side

When a tool requires approval, the agent's reply pauses and the owner receives a notification (in the *Observe* tab in the web UI, and via channel notification if configured). The notification shows:

- Which user / session is making the request.
- Which tool the agent wants to call.
- The full arguments.
- A short rationale from the agent.

The owner clicks approve or reject. The session resumes with that decision; the agent treats the result like any other tool outcome.

Pending approvals time out (default a few minutes); a timeout counts as reject.

---

## 15.5 Sensible Defaults

A starter policy that covers most shared agents:

```bash
# Guests cannot exec.
hermit config --agent main policy set exec '[{"type":"role","value":"guest"}]' --effect deny

# Guests cannot use write-style shell/file tools.
hermit config --agent main policy set file_write '[{"type":"role","value":"guest"}]' --effect deny

# External systems require approval for users.
hermit config --agent main policy set github '[{"type":"role","value":"user"}]' --resource-type mcp --effect require_approval
hermit config --agent main policy set slack  '[{"type":"role","value":"user"}]' --resource-type mcp --effect require_approval
```

Owners are exempt unless you write rules that target them. (You can — sometimes a "make me confirm destructive ops" rule for yourself is wise.)

---

## 15.6 Web Admin UI

The *Manage → Policies* tab shows the rule list with toggles to enable/disable and a form to add new ones.

The *Observe* tab shows pending approvals at the top.

---

## 15.7 Role Differences

| | Owner | User | Guest |
|---|:---:|:---:|:---:|
| See policy rules | ✓ | — | — |
| Add / remove rules | ✓ | — | — |
| Approve pending requests | ✓ | — | — |

---

## 15.8 How-to Recipes

### 15.8.1 Block guests from writing files

```bash
hermit config --agent main policy set file_write '[{"type":"role","value":"guest"}]' --effect deny
```

For path-specific rules, use `--resource-type file` plus a JSON `scope` with `sandbox`, `mode`, and `path`.

**Verify** — ask the agent to write to `/etc/hosts`; it should be denied and recover.

---

### 15.8.2 Require approval for any destructive shell command

```bash
hermit config --agent main policy set exec '[{"type":"role","value":"user"}]' --effect require_approval
```

**Verify** — ask the agent to "delete the temp folder"; you should see an approval prompt.

---

### 15.8.3 Tighten a public agent

For an access-level=public agent, write deny rules for guest role on: `exec`, `file_write`, every MCP tool that costs money, every MCP tool that mutates state in an external system. Allow `file_read` only under a public path.

---

## 15.9 FAQ

**What happens to the agent's reply when a rule denies a call?** The agent sees the denial as a tool error and usually adapts — apologising, suggesting alternatives, or telling you what it wanted to do.

**Can policy rules be time-bounded?** Not natively. If you need temporary loosening, add the rule, use the agent, remove the rule.

**Where do approval notifications go?** *Observe* tab by default. If you have a notification channel configured (e.g., a Telegram chat for the owner), they go there too. Channel adapter support for approval prompts varies — check [Chapter 17](17-channels.md).

---

## 15.10 Pointers

- Coarser, before-policy gating → [Chapter 13 · Access Levels](13-access-levels.md).
- Who counts as guest / user / owner → [Chapter 5 · Users and Identity](05-users-and-identity.md).
- Watch tool calls and approvals as they happen → [Chapter 20 · Web Admin UI](20-web-admin-ui.md).
