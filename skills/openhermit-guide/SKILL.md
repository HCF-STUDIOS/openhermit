---
name: openhermit-guide
description: Explain how an OpenHermit agent behaves for the people interacting with it — owners, users, and guests. Covers roles, identity linking, the agent's tools, access levels, channels, the policy model, and the approval flow. Use when someone asks how an OpenHermit agent works from a caller's perspective. For deploying or administering the platform itself, see openhermit-admin.
---

# OpenHermit Agent Guide

Source code: <https://github.com/HCF-STUDIOS/openhermit>

This guide describes how an OpenHermit agent behaves for the people interacting with it — the owner, regular users, and guests. It is not about deploying the platform; for setup, CLI, and gateway operations see the `openhermit-admin` skill.

## Mental model

An OpenHermit agent has:

- **Members** — exactly one `owner`, plus any number of `user` and `guest` members
- A **toolbelt** — the agent's built-in tools, plus any MCP tools the owner has enabled
- A **security policy** — an access level (who can talk to the agent) and policies (what each caller can do)
- **Channels** — CLI, web, Telegram, Discord, Slack — bridging people on those platforms into membership

Every caller — owner, user, guest, or the agent itself — is checked against the same policy on every tool call, file access, shell command, and MCP call. The only thing that differs by role is which permissions the caller has.

## Roles

Three per-agent roles:

| Role | Typical capabilities |
|------|----------------------|
| `owner` | Full management: members, policies, schedules, channels, MCP, instructions; sees all sessions; only role that can run owner-only tools |
| `user` | Authenticated standard caller; read tools, web, memory read/write, session participation; sees sessions they participated in |
| `guest` | Anonymous or low-trust; read tools, web, memory read, identity linking; sees only their own sessions |

Roles are scoped to an agent: the same person can be `owner` on one agent and `guest` on another. One user can carry multiple identities — e.g. `(telegram, 12345)`, `(slack, U07ABC)`, `(cli, william)` — each identity being a `(channel, channelUserId)` pair.

## Identity linking

Identity linking is central to how OpenHermit behaves across channels. A real person typically reaches the agent from more than one place — CLI on their laptop, Telegram on their phone, the web app on another device — and each of those is a separate identity. Unless those identities are linked to the same user, the agent treats them as different people: separate roles, separate sessions, separate memory visibility.

Three ways to link:

- **Owner shortcut** — the owner directly attaches a known identity to a user (e.g. with `user_identity_link`). Use this when you already know who's behind a given channel ID.
- **Self-service two-step** — any caller can run `identity_link_request` on one channel to mint a short-lived token, then `identity_link_confirm` on the other channel. The flow proves control of both endpoints. Used by guests, users, and owners pairing a new device.
- **`user_merge`** — the owner consolidates two existing user records into one (e.g. a guest auto-created on Telegram into an existing owner user). Merged identities inherit session history, so the surviving user sees both pre-merge conversations.

Once an identity is linked, the role attached to the user applies on every channel that identity reaches the agent from. This is also how an owner reviewing approvals on Telegram is recognized as the owner.

Identity linking does its own verification on top of role checks: the two-step token + channel-proof flow is what actually authorizes the link, regardless of role. Being eligible to attempt a link is not the same as being authorized to complete one.

## Built-in tools

The default-grants column is the role each tool is granted to out of the box. The owner can widen or narrow any of these.

| Tool | What it does | Default grants |
|------|--------------|----------------|
| `exec` | Run shell commands in the configured sandbox | owner |
| `file_read`, `file_list`, `file_stat` | Read files / dirs in the sandbox | owner + user |
| `file_write`, `file_edit`, `file_delete` | Mutate sandbox files | owner |
| `memory_get`, `memory_list`, `memory_recall` | Read agent memory | any |
| `memory_add`, `memory_update`, `memory_delete` | Write agent memory | owner + user |
| `web_search`, `web_fetch` | Search and fetch web pages | any |
| `session_list`, `session_read`, `session_summary`, `session_send` | Inspect / post into sessions | owner + user |
| `schedule_list`, `schedule_runs` | Read schedules | any |
| `schedule_create`, `schedule_update`, `schedule_delete`, `schedule_trigger` | Manage schedules | owner |
| `instruction_update` | Edit system instructions | owner |
| `policy_list`, `policy_set`, `policy_delete` | Manage policies | owner |
| `user_list`, `user_role_set`, `user_merge`, `user_identity_link`, `user_identity_unlink` | Manage members | owner |
| `identity_link_request`, `identity_link_confirm` | Two-step identity linking | any |
| `mcp_status`, `mcp_enable`, `mcp_disable` | Manage MCP server bindings | owner |

MCP server tools are exposed under names like `mcp__{serverId}__{toolName}` and obey the same policy system as built-ins.

When a tool is denied for the calling principal, the tool is **excluded from that turn's tool list** entirely — the model never sees it. So a guest doesn't just get refused when calling `exec`; the agent literally cannot offer `exec` to a guest in the first place.

## Access levels

The agent's `access` setting controls who can become a member at all.

| `access` | Unknown sender auto-becomes guest? | `accessToken` self-join? | Owner can add members? |
|----------|------------------------------------|--------------------------|------------------------|
| `public` (default) | yes | yes | yes |
| `protected` | no | yes (must present `access_token`) | yes |
| `private` | no | no | yes (only way) |

- `public` — open demo agents; any new channel identity is added as `guest` on first message
- `protected` — invite-by-link; share `access_token` with people you want to admit
- `private` — personal agents; only the owner can add members

## Channels

Once a channel (CLI, web, Telegram, Discord, Slack) is enabled by the owner, people on that platform reach the agent through it. Each platform user becomes a `(channel, channelUserId)` identity. First contact resolves to a user record — auto-created as `guest` only if `access` is `public`.

Approval prompts and notifications follow the owner's channels too: an owner who's on Telegram gets approval requests there with approve/reject buttons.

## Policy model

Every gated action — running a tool, reading or writing a file, executing a shell command, calling an MCP tool — has one of three effects evaluated against the caller:

- `allow` — the action proceeds
- `deny` — the action is blocked (and, for tools, the tool isn't even shown to the model)
- `require_approval` — the action pauses and waits for the owner

Effects are decided by **policies** attached to a resource. Each policy says *who* it applies to (everyone, a specific role, or a specific user) and what *effect* it has. The default policy for a tool is whatever's shown in the tools table above; the owner can replace or augment it.

Specific behavior worth knowing:

- **Deny wins.** If any policy says deny for the caller, the action is denied — no matter how many other policies allow it.
- **Restriction is sticky.** If the owner has set policies on a resource but none of them apply to the caller, the caller is denied. Adding an owner-only override on a tool keeps everyone else out automatically.
- **Files** are policed by path prefix (with longest-prefix winning), separately for read and write.
- **Shell commands** can be policed by exact command (e.g. allow `git status` but require approval for anything else) or by working directory.
- **MCP tools** can be policed per-tool, per-server-wildcard (e.g. all tools from one MCP server), or for the server as a whole.
- **Memory** carries its own visibility grants per stored item, controlling who sees that memory when the agent retrieves context. Writing memory is governed by the `memory_add` tool's grants.

Owners manage policies with the `policy_list` / `policy_set` / `policy_delete` tools or the admin UI's Policies tab (presets: Everyone / Owner only / Owner+User / Custom).

## Approval flow

When a policy resolves to `require_approval`, the agent doesn't just refuse — it asks the owner.

- **Real-time approval** — if the owner is in the same interactive session (web or CLI), an inline approve/reject prompt appears. The action proceeds in the same turn if approved.
- **Async approval** — if the requester is on a different channel (e.g. a guest on Telegram), the request is recorded and the owner is notified on their configured channel with approve/reject buttons. The requester is told to wait; the agent stops working on that step. When the owner reviews, the requester's session is updated and they can retry.

Approvals resolve in two flavors:

- **Once** — valid for a short window (default 60 minutes), only for the same requester and same resource. Good for one-off tasks.
- **Persistent** — creates a permanent policy allowing that requester to do that action in the future. Good for "yes, always let this person do this."

## Things worth remembering

- Default policy is permissive (`access: public`, no extra restrictions). Tighten it before sharing widely.
- Session visibility is fixed: the owner sees all sessions; everyone else sees only sessions they participated in.
- Grants are necessary but not sufficient — sensitive flows like identity linking layer their own verification on top of role checks.
- A guest reaching the agent isn't a security failure — it's the default for public agents. Use `protected` or `private` if that's not what you want.
