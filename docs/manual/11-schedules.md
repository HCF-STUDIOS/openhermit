---
title: Schedules
slug: schedules
order: 11
part: Part 2 — Daily Use
description: Have the agent run on a cron or at a one-off time — daily digests, weekly reviews, reminders.
---

# 11. Schedules

A **schedule** is a saved prompt the agent runs on its own at a time you specify. Daily standup digests, weekly retros, "remind me on Friday to send the invoice" — anything you would otherwise have to remember to ask for, the agent can be told to do on its own clock.

---

## 11.1 Two Kinds of Schedule

**Cron** — recurring. "Every weekday at 09:00", "first Monday of the month at 14:00". Uses standard cron expressions.

**One-off** — runs once at an absolute time, then deletes itself. Good for reminders and dated tasks.

Both kinds carry a *prompt* — exactly the text the agent would receive as if you had typed it. When the schedule fires, the gateway opens a new session and submits that prompt.

---

## 11.2 The `hermit schedules` Commands

```bash
# Create a recurring schedule.
hermit schedules create \
  --type cron \
  --cron "0 9 * * 1-5" \
  --prompt "Generate the daily standup digest and post it to #standup." \
  --agent main

# Create a one-off.
hermit schedules create \
  --type once \
  --run-at "2026-05-20T09:00:00Z" \
  --prompt "Remind me to file the quarterly report." \
  --agent main

# List schedules on an agent.
hermit schedules list --agent main

# Delete by ID.
hermit schedules delete <id> --agent main
```

Schedules are stored per agent. The agent runs the saved prompt with its full toolset, so the prompt can ask it to read files, call MCP tools, send messages — anything you could do interactively.

---

## 11.3 Where the Output Goes

A scheduled run is a regular session. Its messages show up in the *Observe* tab in the web UI just like any other session, and the agent can be told to post the result somewhere ("…and send it to me on Telegram", "…and write it to `digest.md`").

If you do not tell the agent where to put the output, it produces a reply that nobody reads. Always close the loop in the prompt.

---

## 11.4 Web Admin UI

The *Manage → Schedules* tab shows existing schedules and a form to create new ones. Same data as the CLI.

---

## 11.5 Role Differences

| | Owner | User | Guest |
|---|:---:|:---:|:---:|
| Create / edit / delete schedules | ✓ | — | — |
| See scheduled runs in Observe | ✓ | ✓ (their sessions) | — |

Schedules are owner-controlled. Users can ask the agent to remember a reminder, but that lands in memory, not in the scheduler.

---

## 11.6 How-to Recipes

### 11.6.1 Daily Telegram digest at 09:00

```bash
hermit schedules create \
  --type cron \
  --cron "0 9 * * 1-5" \
  --prompt "Summarise yesterday's GitHub activity for org/repo and send the summary to me on Telegram." \
  --agent main
```

**Prerequisites** — `mcp_github` enabled with a token, and the Telegram channel linked to your identity.

**Verify** — wait for 09:00 next weekday, or temporarily set the cron to a minute from now and watch the *Observe* tab.

---

### 11.6.2 One-off reminder

```bash
hermit schedules create \
  --type once \
  --run-at "2026-05-15T14:00:00Z" \
  --prompt "Send me a Telegram message: 'Time to renew the domain.'" \
  --agent main
```

**Verify** — `hermit schedules list --agent main` shows the entry until it fires.

---

### 11.6.3 Cancel a recurring schedule

```bash
hermit schedules list --agent main          # find the ID
hermit schedules delete <id> --agent main
```

---

## 11.7 FAQ

**What timezone does cron use?** UTC by default. If you need local time, either translate manually or include the timezone offset in your cron expression's documentation; the gateway evaluates the expression against UTC.

**What if the gateway is down at the scheduled time?** The run is missed; the gateway does not backfill on restart. For critical reminders, prefer a one-off scheduled close to the event and rely on the channel notification.

**Can a scheduled run trigger another schedule?** No — schedules are created by humans via CLI/UI, not by the agent itself.

**Can I edit a schedule?** Delete and recreate. There is no in-place edit.

---

## 11.8 Pointers

- The prompt the schedule runs has full agent capabilities → see [Chapter 8 · Skills](08-skills.md) and [Chapter 9 · MCP Servers](09-mcp-servers.md).
- Watch scheduled runs as they happen → [Chapter 20 · Web Admin UI](20-web-admin-ui.md), Observe tab.
