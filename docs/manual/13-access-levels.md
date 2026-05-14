---
title: Access Levels
slug: access-levels
order: 13
part: Part 3 — Sharing an Agent
description: Public, protected, private — the three settings that decide who can talk to the agent at all.
---

# 13. Access Levels

Access level is the front gate of an agent. Before role policy and per-tool gating apply, the access level decides whether a person can even start a session.

---

## 13.1 The Three Levels

**Public.** Anyone with the agent's URL or channel handle can talk to it. New visitors become guest identities automatically.

**Protected.** Sign-in required. Visitors must authenticate before they can chat. After sign-in they default to guest until you promote them.

**Private.** Only identities the owner has explicitly added can talk. New unknown contacts are blocked at the gate; no automatic guest creation.

| | Public | Protected | Private |
|---|:---:|:---:|:---:|
| Anyone with URL can chat | ✓ | — | — |
| Sign-in required | — | ✓ | ✓ |
| Owner must approve each new identity | — | — | ✓ |
| Auto-create guest on first message | ✓ | ✓ | — |

---

## 13.2 Picking a Level

- **Public** — demos, support bots, anything you intentionally want strangers to use. Pair with tight role policy.
- **Protected** — internal tools you want a known group to use. Sign-in keeps drive-by visitors out and gives you a real identity to attach roles to.
- **Private** — sensitive workspaces, personal agents, anything where unknown contact is a problem.

Default for a freshly created agent is private. Loosening is a deliberate act.

---

## 13.3 Setting the Level

```bash
hermit config --agent <agent-id> security set access public
hermit config --agent <agent-id> security set access protected
hermit config --agent <agent-id> security set access private
```

Web UI: *Manage → Basic* has the access level selector.

Changes take effect immediately. Existing sessions for already-allowed identities are not interrupted.

---

## 13.4 Channel Interaction

The access level applies to every channel uniformly — there is no "public on web, private on Telegram". If you need that asymmetry, run separate agents.

For channels with their own gating (e.g., a private Slack workspace), that gating composes with the agent's access level. A private Slack channel already restricts who can DM the bot; setting the agent to protected on top is mostly redundant.

---

## 13.5 Role Differences

| | Owner | User | Guest |
|---|:---:|:---:|:---:|
| Read current access level | ✓ | ✓ | — |
| Change access level | ✓ | — | — |

---

## 13.6 How-to Recipes

### 13.6.1 Lock down a previously public agent

```bash
hermit config --agent main security set access private
```

Existing guest identities are not auto-removed; they just cannot create new sessions. To clean them out:

Use the gateway admin UI's *Users* tab to find guest members, then remove memberships through the UI or `DELETE /api/agents/main/members/<user-id>`.

---

### 13.6.2 Open a single demo agent publicly while keeping the rest private

Access level is per agent. Set the demo agent to public; leave the others private. Same gateway, different doors.

---

## 13.7 FAQ

**Does the access level change what existing users can do?** No — it only governs new identity creation and session start. To change capabilities, edit roles or policy.

**Can I see who tried to access a private agent and was blocked?** Gateway logs record blocked attempts; surfacing them in the UI is on the roadmap.

**Does access level interact with policy?** They stack. Access level is the outer gate. Policy is the inner gate per tool/resource. A private agent with a permissive policy is still private — only allowed identities reach the policy layer at all.

---

## 13.8 Pointers

- How identities are created and tied to people → [Chapter 5 · Users and Identity](05-users-and-identity.md).
- After someone is in, what they can do → [Chapter 15 · Policy and Approval](15-policy-and-approval.md).
- Bring new people in deliberately → [Chapter 12 · Inviting People](12-inviting-people.md).
