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

- **Tool name** — `file_write`, `exec`, `mcp_github.create_pr`, etc.
- **Tool argument patterns** — e.g., `exec` where the command begins with `rm`.
- **Principal role** — guest / user / owner.
- **Resource path** — for file tools, the path the tool would touch.
- **Channel** — sometimes useful to allow more in CLI/web than in public Telegram.

Rules compose. You usually start with a couple of broad defaults and add specific exceptions as you encounter them.

---

## 15.3 The `hermit policy` Commands

```bash
# List rules on an agent.
hermit policy list --agent main

# Add a rule.
hermit policy add \
  --agent main \
  --match "tool=exec,role=guest" \
  --effect deny

# Add an approval rule for write-y GitHub calls.
hermit policy add \
  --agent main \
  --match "tool=mcp_github.create_pr,role=user" \
  --effect require_approval

# Remove a rule.
hermit policy remove <rule-id> --agent main
```

The exact match syntax depends on your version; `hermit policy --help` and `hermit policy list` are the source of truth for what your gateway accepts.

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
hermit policy add --agent main --match "tool=exec,role=guest" --effect deny

# Guests cannot write files.
hermit policy add --agent main --match "tool=file_write,role=guest" --effect deny

# Any tool that mutates external systems requires approval for users.
hermit policy add --agent main --match "tool=mcp_github.create_pr,role=user" --effect require_approval
hermit policy add --agent main --match "tool=mcp_slack.send_message,role=user" --effect require_approval
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

### 15.8.1 Block file writes outside a sandbox path

```bash
hermit policy add \
  --agent main \
  --match "tool=file_write,path!=sandbox/**" \
  --effect deny
```

(`path!=` syntax illustrative — check your version's `--help`.)

**Verify** — ask the agent to write to `/etc/hosts`; it should be denied and recover.

---

### 15.8.2 Require approval for any destructive shell command

```bash
hermit policy add \
  --agent main \
  --match "tool=exec,arg:command~=^(rm|mv|kill|drop)" \
  --effect require_approval
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
