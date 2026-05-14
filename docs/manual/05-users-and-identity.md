---
title: Users and Identity
slug: users-and-identity
order: 5
part: Part 2 — Daily Use
description: The three roles, how OpenHermit recognises you across channels, the capability matrix, and how to link your Telegram, web, and CLI selves into one user.
---

# 5. Users and Identity

Whether you are the only person using your agent or you share it with several others, OpenHermit needs to know who is talking right now. It figures that out from your identity at each entry point — your Telegram user ID, your web device fingerprint, your CLI username — and then it decides what you can do based on your role on this particular agent. This chapter covers those two questions: how it recognises you, and what each role can do. The end of the chapter has recipes for the most common identity tangles, like wanting your Telegram self and your web self to count as the same person.

---

## 5.1 The Three Roles

Every member of an agent has one of three **roles**.

**Owner.** The person who created the agent (or someone the original owner promoted). Owners can change every setting, add and remove members, see every session on the agent, and use every tool. There is at least one owner per agent; there can be more.

**User.** A trusted member. Users can have normal conversations, use the agent's tools (web search, file operations, exec, memory), and see the sessions they themselves participate in. They cannot change configuration, manage skills or MCP servers, manage other members, or read sessions they did not participate in.

**Guest.** A low-trust member, often auto-created from an unknown identity on a `public` agent. Guests can chat and use a restricted set of tools (web only — no file editing, no exec, no memory writes), and they see only sessions they took part in.

---

## 5.2 How OpenHermit Recognises You

You do not have a single account. You have one or more **identities**, each of which is a `(channel, channel_user_id)` pair:

- CLI → `(cli, <your OS username>)`
- Web → `(web, <a browser device fingerprint>)`
- Telegram → `(telegram, <Telegram user ID>)`
- Discord → `(discord, <Discord user ID>)`
- Slack → `(slack, <Slack user ID>)`

All your identities point to a single internal **user**, and your role on the agent is attached to the user — not to any single identity. Add a new identity, and you keep your role.

The first time a new identity messages an agent, OpenHermit decides what to do based on the agent's [access level](13-access-levels.md): create a guest, demand an access token, or reject. Once the identity is on file, the owner can promote it, link it to an existing user, or merge it with another.

---

## 5.3 You Probably Have More Than One Identity

If you set up an agent on the CLI and then opened it from a browser, those are two identities. If you also message it from Telegram, that is a third. By default, OpenHermit does not know they are the same person — to it, three identities means three users, possibly all with different roles.

This is fine until something surprises you:

- You taught the agent something from CLI; from Telegram it has no idea what you mean.
- You are the owner from CLI but you can only see a guest's view from Telegram.
- A Members list shows your name twice.

The fix is identity linking. The recipes in 5.5 cover it.

---

## 5.4 Two Ways to Link an Identity

There are two paths, and which one fits depends on who is doing the linking.

**Owner-initiated.** The owner picks the identity in the admin UI or, from a channel where they are already recognised as owner, tells the agent "the Telegram user named *William* is also me". The agent links it on the spot. This is the path for an owner cleaning up the members list — including their own duplicate identities — and it requires owner role.

**Token-based, cross-channel proof.** Any user (including a guest) can link their own identities across channels by proving they control both sides. The flow:

1. On channel A, ask the agent to **issue a link token**. It calls `identity_link_request` and prints a short token, valid for about 10 minutes.
2. You carry that token to channel B yourself — copy it, type it into the other client.
3. On channel B, give the token to the agent and ask it to **confirm the link**. The agent calls `identity_link_confirm` with the token. The tool verifies that the redeeming side is a *different* channel from the one that issued the token; that mutual possession is the proof.
4. The two identities are now attached to the same user. If one side was a guest and the other a real user, the guest is absorbed into the real user. If both sides were already non-guest users with distinct roles, the tool refuses and asks an owner to do a manual merge — this prevents a guest's identity from accidentally claiming someone else's user.

No owner approval is needed in the token flow; the security comes from the requirement to actually hold the token on both channels. The owner-initiated path is for cases where you have admin authority and want to skip the token dance.

---

## 5.5 Capability Matrix

This is the source of truth that later chapters refer back to. Each ✓ means "yes, by default"; gaps mean "blocked by role". Custom policy can tighten things further; see [Chapter 15 · Policy and Approval](15-policy-and-approval.md).

| Capability | Owner | User | Guest |
|---|:---:|:---:|:---:|
| Send messages, chat | ✓ | ✓ | ✓ |
| Use web tools (search, fetch) | ✓ | ✓ | ✓ |
| Read/write workspace files | ✓ | ✓ | — |
| Run sandbox commands (exec) | ✓ | ✓ | — |
| Read/write long-term memory | ✓ | ✓ | — |
| Read/write instructions | ✓ | — | — |
| List sessions | All | Own | Own |
| Send proactive message to another session | ✓ | — | — |
| Manage schedules | ✓ | Read | Read |
| Manage skills | ✓ | — | — |
| Manage MCP servers | ✓ | — | — |
| Manage channels | ✓ | — | — |
| Manage secrets | ✓ | — | — |
| Add/remove members, change roles | ✓ | — | — |
| Merge identities | ✓ (any) | Own | — |

---

## 5.6 How-to Recipes

### 5.6.1 Make Telegram see you as yourself, not as a guest

**Scenario** — you created your agent from the web (so the web identity is the owner), then you opened a Telegram chat with the bot. Telegram sees a new identity and either drops your message (on `protected` or `private` access) or creates a guest user.

**Prerequisites** — the agent has Telegram connected ([Chapter 17 · Channels](17-channels.md)). You have already sent at least one message to the bot from Telegram, so the agent has seen that identity.

**Ways to do it**

*Let the agent do it.* From the web (where you are owner), just describe the other identity in plain words:

> The user chatting with you on Telegram, named "William", is also my account.

The agent looks up the matching Telegram identity, links it to your user record, and confirms. You do not need to dig up the numeric Telegram user ID — naming the display name is enough as long as it is unambiguous.

*Web admin UI.* Open the agent's *Manage* page, go to the section listing members (typically reached via the `/api/agents/<id>/members` flow surfaced in the UI; if your admin UI does not expose this directly, use the API path below). Find your own entry, add an identity, choose `channel = telegram`, paste the ID.

*HTTP API.* Owner-only:

```bash
curl -X POST "$GATEWAY/api/agents/<agent-id>/members" \
  -H "Authorization: Bearer <your-jwt>" \
  -H "Content-Type: application/json" \
  -d '{"channel":"telegram","channelUserId":"656756615","userId":"<your-user-id>"}'
```

**Verify** — send a message from Telegram. Ask the agent "who am I?" — it should answer with your owner display name, not "guest".

**Common issues** — if the agent already auto-created a separate guest user from your Telegram identity before you linked, you have to merge the duplicate into yourself; see 5.6.4.

---

### 5.6.2 Link two of your own channels using a token

**Scenario** — you are the same person on web (recognised as your real user) and on Telegram (currently a guest). No owner is helping you; you are doing it yourself.

**Prerequisites** — you have already messaged the agent from both channels at least once, so each identity exists on the agent.

**Ways to do it**

1. From the channel where you are already recognised as yourself (say, web), tell the agent:

   > Generate a link token so I can attach another channel to this account.

   The agent calls `identity_link_request` and replies with a short token, e.g. `Xq4Aw8Zk`, valid for about 10 minutes.

2. Switch to the other channel (Telegram). Send the agent a message containing that token:

   > Link this Telegram account using token `Xq4Aw8Zk`.

   The agent calls `identity_link_confirm`. Because the redeeming channel (Telegram) differs from the issuing channel (web), the proof check passes; the Telegram identity is attached to your existing user, and the guest record is absorbed.

**Verify** — ask the agent from Telegram "who am I?" — it should name your real user, not "guest".

**Common issues**

- *"Token expired."* It is only valid for ~10 minutes. Issue a new one.
- *"Same channel."* Tokens must be redeemed on a different channel from the one that issued them.
- *"Already linked to a different user."* If both sides are already established non-guest users, the token flow refuses on purpose — ask an owner to run a merge ([5.6.4](#564-merge-two-identities-that-ended-up-as-two-users)).

---

### 5.6.3 Make a browser session see you as owner

**Scenario** — you ran `hermit setup` on the CLI, that made you owner. Now you open the web UI in a browser; the web identity is a different `(web, <fingerprint>)` tuple and you appear as guest or unauthenticated.

**Prerequisites** — none.

**Ways to do it**

*Web login from CLI.* The fastest path:

```bash
hermit web start
# Open the printed local web URL, then sign in with the same gateway credentials.
```

The web server command starts the UI and prints the listening URL; it does not itself create a browser identity link. If the browser still appears as a separate guest after sign-in, use the identity-link flow from 5.6.2.

*Link the web identity manually.* Same shape as 5.6.1 with `channel = web` and the device fingerprint shown in the Admin UI.

**Verify** — the Admin UI shows the full management surface (Manage tab is visible and editable), not just a chat view.

**Common issues** — using a different browser, or an incognito window, gives you a new web identity. Link that identity again if you want it to resolve to the same user.

---

### 5.6.4 Merge two identities that ended up as two users

**Scenario** — you have two entries in the Members list that are obviously the same person (you, with two channel identities, accidentally created as two users because you did not link in time).

**Prerequisites** — you are an owner.

**Ways to do it**

*Tell the agent.* "Merge user `u_abc` into user `u_xyz`."

The agent calls `user_merge`. After it returns, every old identity attached to `u_abc` now resolves to `u_xyz`. Old sessions and messages keep their original sender attribution, so history is intact.

*HTTP API.* If the admin UI exposes a Merge action, use it. Otherwise issue the same call through the agent.

**Verify** — the Members list now shows one entry with both identities listed.

**Common issues** — merging is one-way. The old user record is marked `merged_into`; identity resolution follows the link, but you cannot un-merge without manual database work.

---

### 5.6.5 Promote a user to owner

**Scenario** — you want to give someone full administrative access to an agent.

**Prerequisites** — you are an owner.

**Ways to do it**

*Tell the agent.* "Set user `u_xyz`'s role on this agent to owner."

The agent calls `user_role_set`. The promoted user keeps their existing identities; on their next message they get the owner toolset.

**Verify** — the promoted person can now open the *Manage* tab and edit settings.

**Common issues** — there is no "demote owner" safeguard. If you give owner to the wrong person, you have to demote them back — be deliberate.

---

## 5.7 FAQ

**The agent calls me "guest" even though I created it. Why?** You probably created it from one channel (say, CLI) and you are messaging from another (say, Telegram). Each channel is a separate identity until you link them. See 5.6.1.

**Can a guest become a user without the owner doing anything?** No. Role changes are owner-only.

**If I merge two users, do their memories merge too?** Long-term memory is per-agent, not per-user, so there is no per-user memory to merge. Session participation is recomputed: sessions where either of the old users participated now show the merged user.

**Can someone be owner on one agent and guest on another?** Yes — roles are per-agent. The same user can have different roles on different agents in the same instance.

**Group chat: who is "the user" when the agent is replying?** The runner attributes each *message* to its sender. The agent sees each message tagged with the sender's display name (and, on group channels, sees that the conversation has multiple people).

---

## 5.8 Pointers

- Want to give someone access for the first time → [Chapter 12 · Inviting People](12-inviting-people.md).
- Want to restrict what a particular role or user can call → [Chapter 15 · Policy and Approval](15-policy-and-approval.md).
- Want to know how Telegram/Discord/Slack actually get connected → [Chapter 17 · Channels](17-channels.md).
