---
title: Web Admin UI
slug: web-admin-ui
order: 20
part: Part 5 — Reference
description: A tour of the web interface — Chat, Observe, Manage — and what you do in each tab.
---

# 20. Web Admin UI

The web UI is what most owners spend their time in. Three top-level tabs cover the surface area: **Chat** to talk, **Observe** to watch, **Manage** to configure.

---

## 20.1 Chat

The conversation surface. Pick an agent in the sidebar, start a new session or resume an existing one, type messages, drop attachments. Same content store as channels — anything you do here lands in the same memory and session log.

Useful corners:

- **Session list** in the sidebar — every conversation with this agent, by date.
- **Tool calls expand** — under each agent reply, expand to see the tools it called, with arguments and results.
- **Attachments** — drag a file directly into the chat field. It is written to the workspace; the agent is notified.

---

## 20.2 Observe

A read-only window into agent activity across all sessions and channels.

Useful for:

- Watching scheduled runs as they fire.
- Auditing tool calls — filter by tool name, see arguments and results.
- Spotting failed turns — the runner reports failures here.
- Approving pending tool calls (when policy says approval is required).

Filters typically include: agent, user, channel, session, tool name, time window.

---

## 20.3 Manage

Configuration. Sub-tabs (the exact set depends on your gateway version):

- **Basic** — agent name, model, access level.
- **Secrets** — names and set/delete (values hidden after setting).
- **Channels** — adapter list, enable/disable toggles, add configuration.
- **Skills** — registry, assignments, enable/disable toggles.
- **MCP** — registered servers, assignments, enable/disable toggles.
- **Schedules** — list and create form.
- **Policies** — rule list and add form.

The data behind every tab is the same gateway store used by the CLI and API; some surfaces, such as Channels, are currently UI/API-only.

---

## 20.4 Role Differences

| | Owner | User | Guest |
|---|:---:|:---:|:---:|
| Chat | ✓ | ✓ | ✓ (subject to access level) |
| Observe | ✓ | partial (own sessions) | — |
| Manage | ✓ | — | — |

A signed-in user sees the Chat tab and a limited Observe view; only owners see Manage at all.

---

## 20.5 How-to Recipes

### 20.5.1 Find a specific past conversation

Chat → session list → search by date or by a snippet of text.

If you need to find a session by tool call (e.g., "the session where the agent ran `git push`"), use *Observe* and filter by tool name.

---

### 20.5.2 Watch a scheduled run live

*Observe* → set the filter to your agent → wait for the schedule to fire. The new session shows up in real time; expand to see each tool call as it happens.

---

### 20.5.3 Approve a pending tool call

*Observe* → top banner shows pending approvals. Click the request → review tool + args → approve or reject. The session resumes.

---

## 20.6 FAQ

**Where is the file browser?** Some gateway builds expose a workspace file browser under *Manage → Files*. If yours does not, list files through the agent itself ("list workspace files").

**Can I export observations?** Click into a session and use the browser print/save — there is no formal export yet.

**Two browsers, two owners — any conflict?** No. Edits are last-write-wins; the data is consistent across sessions.

---

## 20.7 Pointers

- CLI and API equivalents for management operations → [Chapter 19 · CLI Cheatsheet](19-cli-cheatsheet.md).
- What each Manage sub-tab maps to in this manual → the chapter of the same name.
