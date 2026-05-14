---
title: Inviting People
slug: inviting-people
order: 12
part: Part 3 — Sharing an Agent
description: Bring other people onto your agent — as users or guests — across CLI, web, and channels.
---

# 12. Inviting People

Sharing an agent means letting someone else talk to it. The mechanics are: decide their role (user or guest — owners are not invited, they own the instance), give them a way to reach the agent (a channel link or a web URL), and let the identity system tie their channel presence to a stored user record.

This chapter is the practical guide to that flow. The conceptual basis lives in [Chapter 5 · Users and Identity](05-users-and-identity.md).

---

## 12.1 Decide the Role First

- **User** — a known person you trust with the agent's full read/write tools. They can chat, attach files, use enabled skills, call MCP tools that policy allows for users.
- **Guest** — anyone else. Reduced toolset by default — no file write, no memory write, no exec. Good for public-facing agents, casual sharing, demos.

You can promote a guest to user later, so when in doubt, start as guest.

---

## 12.2 Three Ways to Reach the Agent

**Web URL.** The web UI has a per-agent chat URL. Anyone with the URL can land in a session, subject to whatever access control the agent has (public / protected / private — see [Chapter 13](13-access-levels.md)).

**Channel handles.** If you have linked Telegram / Discord / Slack to the agent, share the bot's handle. The first message someone sends creates an identity tuple (channel, channel_user_id) that defaults to a guest user.

**CLI.** Not really an invite path — CLI access is for owners and trusted users with hermit installed and configured against the same gateway.

---

## 12.3 The Invite Flow (Per Channel)

### Telegram / Discord / Slack

1. The other person finds the bot (you give them the handle).
2. They send a message — say, `/start` for Telegram.
3. The gateway creates a guest user pinned to that channel handle.
4. You (the owner) decide: leave them as guest, link them to an existing user record (if they are someone you already know), or promote them to user from the gateway admin UI or by asking the agent to call `user_role_set`.

The supported management surfaces are in [Chapter 14 · Managing Members](14-managing-members.md).

### Web

1. You share the agent URL.
2. They sign in (if the agent is protected) or land directly (if public).
3. A web identity is created — same flow as a channel.
4. Same options for the owner afterwards: leave as guest, link, or promote.

---

## 12.4 Owner-Side Checklist Before Inviting

Going one by one:

- **Access level set?** Public, protected, or private. Decide before sharing the URL. See [Chapter 13](13-access-levels.md).
- **Default role for new identities?** Defaults to guest. If you want a closed invite-only experience, set the access level to private and approve each new identity by hand.
- **Sensitive files in the workspace?** Anything in the workspace is reachable by anyone who can talk to the agent and has file-tool permissions. Move sensitive content out, or add a policy rule. See [Chapter 10](10-files-and-workspace.md) and [Chapter 15](15-policy-and-approval.md).
- **MCP credentials**? Tokens for GitHub, Slack, etc. are reachable through the agent's tools — anyone allowed to call the relevant tool can act with those credentials. Apply role policy if a tool should be owner-only.

---

## 12.5 Role Differences

| | Owner | User | Guest |
|---|:---:|:---:|:---:|
| Invite others | ✓ | — | — |
| Promote a guest to user | ✓ | — | — |
| Revoke access | ✓ | — | — |

Only owners invite and revoke. Users and guests can talk to the agent but cannot change who else can.

---

## 12.6 How-to Recipes

### 12.6.1 Invite a co-worker as a user via Telegram

**Steps**

1. Make sure the Telegram channel is configured on the agent (see [Chapter 17](17-channels.md)).
2. Share the bot handle (e.g., `@my_agent_bot`).
3. Wait for them to send their first message — a guest identity is created.
4. List recent identities in the gateway admin UI's *Users* tab, or ask the agent as owner to list users.
5. Promote them from the admin UI, or ask the agent as owner: "promote `<user-id>` to user on `main`."

**Verify** — they ask the agent to write a file; the file gets written (guests cannot, users can).

---

### 12.6.2 Open the agent up to a public web URL with guest access

**Scenario** — you want a public demo agent.

**Steps**

1. Set access to public ([Chapter 13](13-access-levels.md)).
2. Share the agent's chat URL.
3. Visitors land as guests automatically; no further action needed from you.

**Common issues** — public agents must have strict policy around tools that touch your credentials or files. A public guest with `mcp_github` enabled can read public issues fine; if your token has write scopes it can also open PRs. Apply policy to deny write tools for the guest role. See [Chapter 15](15-policy-and-approval.md).

---

### 12.6.3 Revoke someone's access

Demote them from the gateway admin UI, or ask the agent as owner to demote the user. To drop their membership entirely, use the member API: `DELETE /api/agents/<agent-id>/members/<user-id>`.

If they re-engage the agent, they will create a fresh guest identity (unless the channel itself is access-controlled at the operator level).

---

## 12.7 FAQ

**Can I send an email invite?** Not built in. Share the URL or the bot handle through whatever channel you already use.

**Do I need an invite system or signup flow?** No. Identity is created lazily when someone first contacts the agent. You moderate after the fact.

**Can someone be a user on one agent and a guest on another?** Yes. Roles are per agent.

---

## 12.8 Pointers

- Manage who has access after the invite → [Chapter 14 · Managing Members](14-managing-members.md).
- Set whether the agent is public / protected / private → [Chapter 13 · Access Levels](13-access-levels.md).
- Restrict what a role can do beyond the defaults → [Chapter 15 · Policy and Approval](15-policy-and-approval.md).
