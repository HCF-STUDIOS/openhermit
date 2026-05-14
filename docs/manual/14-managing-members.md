---
title: Managing Members
slug: managing-members
order: 14
part: Part 3 — Sharing an Agent
description: List, promote, demote, link, and delete users — the day-to-day moderation of who is on your agent.
---

# 14. Managing Members

Once people start showing up — through a channel invite or a public URL — you need to see who they are, decide what role they hold, and occasionally clean up. This chapter is the operator's pocket reference for that work.

---

## 14.1 The `hermit users` Commands

```bash
# List users on an agent.
hermit users list --agent main

# Filter by role.
hermit users list --agent main --role guest

# Show one user with their linked identities.
hermit users get <user-id> --agent main

# Promote / demote.
hermit users update <user-id> --role user  --agent main
hermit users update <user-id> --role guest --agent main

# Link a channel identity to an existing user record.
hermit users link <user-id> --channel telegram --channel-user-id 12345 --agent main

# Remove a channel identity from a user.
hermit users unlink <user-id> --channel telegram --agent main

# Delete a user entirely (channel re-engagement creates a fresh guest).
hermit users delete <user-id> --agent main
```

Promotion and demotion take effect on the next message.

---

## 14.2 Reading the User List

A row typically shows: user ID, role, display name (best guess from the channel), linked identities (`telegram:12345`, `web:abc-uuid`), created date, last-seen date.

Two columns to skim first:

- **Role** — guests vs users. New rows are usually guests.
- **Linked identities** — if one user has both `telegram:` and `web:` identities, they have been merged and the agent treats them as one person across channels.

---

## 14.3 Web Admin UI

There is currently no dedicated *Manage → Members* tab in the web UI. Membership operations live in the CLI. The roadmap includes a UI for this.

---

## 14.4 Role Differences

| | Owner | User | Guest |
|---|:---:|:---:|:---:|
| List users | ✓ | — | — |
| Promote / demote | ✓ | — | — |
| Link / unlink identities | ✓ | — | — |
| Delete users | ✓ | — | — |

Only owners manage membership.

---

## 14.5 How-to Recipes

### 14.5.1 Merge two identities into one person

**Scenario** — you appear in the user list twice: once from your Telegram identity, once from your web sign-in. You want them collapsed.

**Steps**

1. List and identify both user records:

   ```bash
   hermit users list --agent main
   ```

2. Pick the one you want to keep (call it `<keep-id>`) and note the channel identity on the other (`<drop-id>`). Suppose the keeper has the web identity and the other has Telegram.
3. Link the Telegram identity to the keeper:

   ```bash
   hermit users link <keep-id> --channel telegram --channel-user-id <telegram-user-id> --agent main
   ```

4. Delete the now-empty other record:

   ```bash
   hermit users delete <drop-id> --agent main
   ```

**Verify** — `hermit users get <keep-id>` shows both linked identities. Send a message from each channel; both should attribute to the same user.

---

### 14.5.2 Promote a guest to user after vetting

```bash
hermit users update <user-id> --role user --agent main
```

**Verify** — have them ask the agent to write a file; it succeeds.

---

### 14.5.3 Bulk-clean stale guests

```bash
# List guests older than 90 days (use --since/--until if your build supports it,
# otherwise eyeball the last-seen column).
hermit users list --agent main --role guest
# Then delete the ones you no longer want:
hermit users delete <id> --agent main
```

There is no built-in "delete-all-stale-guests" command; do this when the list gets noisy.

---

### 14.5.4 Audit who acted on a sensitive tool

This is observability, not membership management. See [Chapter 20 · Web Admin UI](20-web-admin-ui.md) — *Observe* tab — for filtering sessions by tool call.

---

## 14.6 FAQ

**Can a user have many channel identities?** Yes — link as many as you want. The agent treats them as one person.

**Can the same channel identity belong to two users?** No. The tuple `(channel, channel_user_id)` resolves to exactly one user. If you re-link to a different user, the old link is detached first.

**Does deleting a user delete their session history?** Sessions are tagged with their user ID; deleting the user does not erase past sessions by default. To purge sessions, use the session admin commands ([Chapter 21 · Troubleshooting](21-troubleshooting.md) lists them).

---

## 14.7 Pointers

- Concepts behind identities and roles → [Chapter 5 · Users and Identity](05-users-and-identity.md).
- Decide who can reach the agent at all → [Chapter 13 · Access Levels](13-access-levels.md).
- Limit what each role can do → [Chapter 15 · Policy and Approval](15-policy-and-approval.md).
