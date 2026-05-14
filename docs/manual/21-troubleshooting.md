---
title: Troubleshooting
slug: troubleshooting
order: 21
part: Part 5 — Reference
description: Symptoms, likely causes, and the first three things to check.
---

# 21. Troubleshooting

A symptom-first reference. For each issue: what you see, what is most likely wrong, what to try first.

---

## 21.1 Agent does not reply

**Likely** — gateway is down, channel adapter is broken, model credential is missing or rotated out.

**Check**

1. `hermit doctor` — basic connectivity to the gateway.
2. *Manage → Channels* — is the channel enabled and free of missing-secret warnings?
3. Try the web UI: if web works but Telegram does not, the channel is the issue, not the agent.
4. *Observe* tab — is the session showing a model error?

---

## 21.2 Tool call fails repeatedly

**Likely** — credential expired, MCP server crashed, argument schema drift, policy denial.

**Check**

1. Expand the failed call in *Observe*. The error message is usually specific.
2. If credential-related → rotate the secret, restart the MCP server (`hermit mcp disable` + `enable`).
3. If schema-related → check whether the MCP server version was bumped.
4. If denial → look at *Policy* — a rule may be denying without obvious notice.

The agent runner aborts the turn after 15 consecutive tool failures to prevent loops; that abort itself shows in *Observe*.

---

## 21.3 Memory does not stick

**Likely** — the agent did not classify the fact as durable, or the memory tool is policy-denied.

**Check**

1. Ask the agent: "What do you remember about <topic>?" If empty, it was not stored.
2. Explicit retry: "Please remember that <fact>." Most reliable way to force a store.
3. Check policy for any rule blocking `memory_*` tools.

---

## 21.4 New schedule never fires

**Likely** — cron expression wrong timezone, gateway was down at fire time, schedule was created on the wrong agent.

**Check**

1. `hermit schedules list --agent <id>` — confirm the schedule is on the right agent.
2. Read the cron — UTC is the default; if you used a local-time expression it fires at the UTC equivalent.
3. *Observe* for the agent — does any session appear at the expected time?

---

## 21.5 Someone can do something they should not

**Likely** — role is wrong (they were promoted by mistake), or policy is missing a rule.

**Check**

1. Gateway admin UI *Users* tab, or `user_list` as owner — confirm their role.
2. `hermit config --agent <id> policy list` — does the relevant deny rule exist for their role?
3. Test by impersonation: sign in as them on web (or use a test guest identity) and reproduce.

---

## 21.6 Web UI shows stale data

**Likely** — browser cache, or the gateway was restarted with a build mismatch.

**Check**

1. Hard refresh (Cmd-Shift-R / Ctrl-Shift-R).
2. If the UI is from a stale build (operator just upgraded), the operator may need to rebuild the static assets.

---

## 21.7 CLI says "not authenticated"

**Likely** — the local config does not have credentials for the gateway, or the gateway URL is wrong.

**Check**

1. `hermit setup` again — re-enter gateway URL and token.
2. `hermit doctor` — should report green.

---

## 21.8 Files I uploaded are missing

**Likely** — they were uploaded to a different agent, or the sandbox path is not what you expected.

**Check**

1. Ask the agent: "List files in your workspace."
2. Confirm you uploaded to the same agent that you are now asking. Per-agent isolation is total.

---

## 21.9 The agent contradicts itself between sessions

**Likely** — memory was updated in one session and not in another, or two memory entries conflict.

**Check**

1. Ask: "What do you remember about <topic>? List every relevant entry."
2. Tell it to consolidate: "These two entries conflict. The correct version is X. Update accordingly."

---

## 21.10 When to escalate to your operator

- Gateway-level errors that persist across agents.
- Secrets at the gateway level (model provider keys) need rotating.
- A new MCP server needs installing.
- Workspace storage is full.
- Backups, upgrades, certificate renewal — anything below the user-facing layer.

---

## 21.11 Pointers

- Find the specific chapter for any feature mentioned above using [the index](README.md).
- Frequently asked at a higher level → [Chapter 22 · FAQ](22-faq.md).
