---
title: Files and Workspace
slug: files-and-workspace
order: 10
part: Part 2 — Daily Use
description: The agent's filesystem — what it can see, how to upload and download files, and how the sandbox isolates the workspace.
---

# 10. Files and Workspace

Every agent has its own **workspace** — a filesystem inside a sandboxed environment where the agent can read, write, and execute. This is where the files you attach go, where the agent saves generated output, and where it clones a repo if you ask. Understanding what is in the workspace and how to move things in and out is most of what you need to know.

---

## 10.1 What the Workspace Is

The workspace is the agent's "computer". It is a directory inside a sandbox (a Docker container, an E2B cloud sandbox, or a Daytona workspace, depending on how the instance was configured — that choice is made operator-side). From your seat:

- It is **per agent**: each agent has its own. Two agents on the same instance do not share workspace files.
- It is **shared across sessions**: a file you uploaded in session A is visible to the agent in session B.
- It is **persistent**: files survive restarts, gateway upgrades, and agent disable/enable.
- It is **isolated**: code the agent runs cannot escape the sandbox.

The agent's tools for reaching the workspace are file read, write, search, and shell exec — same tools any reasonable engineer would expect.

---

## 10.2 What the Agent Can See

Inside the workspace, the agent has free read access. There is no per-session file isolation — a file uploaded in a private session with you is still in the workspace and the agent will see it when chatting with someone else (subject to that user's role and policy).

If you have sensitive files you do not want any session to surface, do not upload them, or put them in a path you have explicitly excluded via policy. See [Chapter 15 · Policy and Approval](15-policy-and-approval.md).

---

## 10.3 Getting Files In

**Web UI.** Drag a file into the chat window. The adapter writes it into a known path inside the workspace and notifies the agent. The agent's reply will reference the new file by name.

**Telegram / Discord / Slack.** Send a file attachment in the chat. The channel adapter does the same thing — copies into the workspace, hands the agent a notification.

**CLI.** There is no built-in upload command in `hermit chat`. Either drop the file directly into the workspace path (operator-known location), or use the web UI for that one upload and come back to CLI.

**The agent fetches it.** Often the easiest path: paste a URL and say "download this PDF and analyse it". The agent uses its fetch tool (or an MCP server) and the file ends up in the workspace.

---

## 10.4 Getting Files Out

**Ask the agent.** "Show me the contents of `report.md`" or "encode `chart.png` as base64 and paste it" works for small files.

**Web UI.** The web UI typically renders artefacts (markdown, code, images) inline. Right-click to save.

**Channel adapters.** Ask the agent to send a file back as an attachment; Telegram and Slack adapters support this.

**Direct sandbox access.** For bulk operations, the operator can configure direct download from the sandbox; this is not a default user-side feature.

---

## 10.5 The Tools the Agent Uses

You will see these in the *tool calls* view if you expand a reply:

- **File read** — fetch a file's content into context.
- **File write** — create or overwrite a file.
- **File search / list** — grep, glob, ls equivalents.
- **Exec** — run a shell command in the sandbox.

Exec is the most powerful and the most policy-sensitive. By default, owners and users have it; guests do not. Sensitive commands can be deny-listed via policy (see [Chapter 15](15-policy-and-approval.md)).

---

## 10.6 Role Differences

| | Owner | User | Guest |
|---|:---:|:---:|:---:|
| Read files | ✓ | ✓ | — |
| Write files | ✓ | ✓ | — |
| Run shell commands | ✓ | ✓ | — |
| Upload via channel | ✓ | ✓ | (depends on policy) |
| Download | ✓ | ✓ | (depends on policy) |

Guests get a no-file-tools experience by default. That keeps a public-facing agent (auto-creating guest users from arbitrary Telegram or web visitors) from getting a stranger's file dropped into shared workspace storage.

---

## 10.7 How-to Recipes

### 10.7.1 Upload a CSV and ask the agent to analyse it

**Scenario** — you have a sales export and you want trends.

**Steps**

1. Open the web UI, pick the agent, drag `sales-q1.csv` onto the chat.
2. Ask: "Analyse this — what are the top three trends?"

The agent reads the file, runs analysis (often with Python via exec), and replies.

**Verify** — the reply names specific values from your file.

---

### 10.7.2 Have the agent generate a file and download it

**Scenario** — you want a markdown summary of a long conversation.

**Steps**

> Save a markdown summary of this conversation to `summary.md` in the workspace.

The agent writes the file. Then either:

- Ask the agent to read it back inline ("show me `summary.md`") and copy from the reply.
- In the web UI, navigate to the workspace browser (*Manage → Files*, if your instance exposes one) and download directly.

---

### 10.7.3 Clean up the workspace

**Scenario** — over months of use the workspace has accumulated files you no longer need.

**Steps**

Ask the agent:

> List files in the workspace older than 90 days; for each, summarise its purpose and ask me whether to keep or delete.

Walk through interactively. Or do it bulk:

> Delete every file matching `tmp_*` or `.log`.

**Verify** — `ls` the workspace via the agent or the operator-provided viewer.

**Common issues** — if the agent has been running scripts that write to specific paths, those scripts may break if you delete their working files. Look before you sweep.

---

### 10.7.4 Block guests from a particular path

**Scenario** — a public agent has a few private notes under `private/` and you do not want guests to surface them.

**Steps**

Add a policy rule denying file operations under `private/` for the `guest` role. See [Chapter 15 · Policy and Approval](15-policy-and-approval.md).

**Verify** — sign in as guest (or use a fresh public identity) and ask the agent about a file under `private/`; the file read should be refused.

---

## 10.8 FAQ

**Where does my uploaded file go inside the workspace?** Typically a known uploads path; the specific layout depends on the sandbox backend. The agent knows the path and will reference it in replies.

**Can the agent install software in its sandbox?** Yes, within the sandbox — apt/pip/npm and similar work. Changes persist for that agent's workspace.

**If the sandbox dies, do I lose my files?** No. The workspace is backed by persistent storage; restarting the sandbox does not erase it.

**Two agents on the same instance — do they see each other's files?** No. Per-agent isolation.

**Multiple users on one agent — do they see each other's uploads?** Yes. The workspace is per agent, not per user. If you need per-user isolation, run one agent per user.

---

## 10.9 Pointers

- Restrict what the agent can run via exec → [Chapter 15 · Policy and Approval](15-policy-and-approval.md).
- Manage secrets the agent uses inside the sandbox → [Chapter 18 · Secrets](18-secrets.md).
- The agent's broader memory model → [Chapter 6 · Memory](06-memory.md).
