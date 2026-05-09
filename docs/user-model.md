# User Model

OpenHermit identifies users through channel identities and grants permissions through per-agent roles.

## Data Model

| Table | Purpose |
|-------|---------|
| `users` | user ID, display name, merge target, timestamps |
| `user_identities` | maps `(channel, channel_user_id)` to `user_id` |
| `user_agents` | role for a user on an agent |

Roles:

- `owner`: full management and tool access
- `user`: standard interaction access
- `guest`: limited access for unknown or low-trust identities

## Identity Resolution

A caller identity is:

```ts
interface CallerIdentity {
  channel: string;
  channelUserId: string;
}
```

Examples:

- `cli` + OS username
- `web` + device fingerprint
- `telegram` + Telegram user ID
- `discord` + Discord user ID
- `slack` + Slack user ID

When a session opens or a message includes a sender, the runner resolves the identity to a user. Whether unknown identities get auto-promoted to a guest depends on the agent's [access level](#access-levels). The owner can later link, unlink, merge, or change roles.

## Access Levels

Each agent has an `access` field on its security policy that controls who
can interact with it. Three values:

| `access` | Auto-create guest from unknown channel sender? | accessToken self-join? | Owner-added members? |
|----------|------------------------------------------------|------------------------|----------------------|
| `public` (default) | yes | yes | yes |
| `protected` | no | yes (must present `access_token`) | yes |
| `private` | no | no | yes (only path) |

- **`public`**: any incoming message from a previously-unseen `(channel, channelUserId)` becomes a `guest` member on the agent. Suitable for open demos.
- **`protected`**: unknown senders are dropped at the runtime boundary. To join, callers must `POST /api/agents/:id/members` with `{ accessToken: "..." }` matching the policy's `access_token`. Suitable for invite-by-link / shared-secret flows.
- **`private`**: unknown senders are dropped, and accessToken self-join is rejected. Membership is owner/admin-only via the members API. Suitable for personal agents and internal tools.

`access_token` is set on the agent's security policy alongside `access` itself.

### Editing the security policy

Three equivalent ways to flip `access` (or any other field on the security policy):

```bash
# CLI: read / write a single field, or pipe a full JSON
hermit config security show --agent one
hermit config security set access private --agent one
hermit config security set access_token "shared-secret" --agent one
echo '{"autonomy_level":"full","access":"private"}' \
  | hermit config security write --agent one
```

```bash
# HTTP (admin or owner JWT):
curl -H "Authorization: Bearer <token>" \
  https://gateway/api/agents/one/security              # GET current policy
curl -X PUT -H "Authorization: Bearer <token>" \
     -H "Content-Type: application/json" \
     -d '{"autonomy_level":"full","access":"private"}' \
  https://gateway/api/agents/one/security              # overwrite
```

Admin UI: the agent's actions menu in the fleet view has a **Security** entry that opens a JSON editor on the policy.

The runtime reloads its in-memory copy after a successful write — no agent restart needed. Validation rejects unknown values for `access`.

### Adding members

`POST /api/agents/:agentId/members` accepts two body shapes:

```jsonc
// Existing internal user
{ "userId": "u_abc", "role": "user" }

// Channel identity (owner / admin only). Creates the user + identity link
// on first sight; idempotent on subsequent calls.
{
  "channel": "telegram",
  "channelUserId": "656756615",
  "displayName": "William",
  "role": "user"
}
```

Auth-mode rules:

- `admin`: either body shape; can grant any role including `owner`.
- JWT `user` with `owner` role on this agent: either body shape; cannot grant `owner` (use admin).
- JWT `user` with no role yet: self-join only (`userId` omitted or matches caller). Subject to the access-level rules above.

`GET /api/agents/:agentId/members` (owner / admin) returns each member with their role, display name, and the list of `(channel, channelUserId)` identities linked to them — useful for owners auditing who's in.

`DELETE /api/agents/:agentId/members/:userId` (owner / admin) removes the membership row. The user record and identity links are preserved so re-adding them later is one call.

## Owner Bootstrap

The first trusted CLI/web identity can bootstrap ownership for an agent. Created agents may also receive an explicit `ownerUserId`.

## Session Participation

Sessions store `userIds`. Non-owner users can only read/resume sessions where they are participants. Owners can read all sessions for the agent.

Group channel sessions can include multiple users. The runtime resolves per-message sender identity when channel adapters provide `sender`.

## Tool Access

Toolsets are filtered by role and available stores:

| Role | Effective access |
|------|------------------|
| `owner` | exec, web, memory, instruction, user, session, session_send, schedules, MCP management |
| `user` | web, memory, session read/list/summary, permitted normal interaction |
| `guest` | restricted web/session/schedule read access |

Some tools also require runtime capabilities, such as `scheduleStore`, `userStore`, `sessionStore`, channel outbound adapters, or MCP client manager.

## Agent Tools

Owner-focused user tools:

- `user_list`
- `user_identity_link`
- `user_identity_unlink`
- `user_role_set`
- `user_merge`

Session tools:

- `session_list`
- `session_read`
- `session_summary`
- `session_send`

`session_send` sends proactive messages through registered channel outbound adapters. The delivery is recorded in the target session as a normal assistant log entry; delivery details (`channel`, `to`, `messageId`, `fromSession`) are sibling keys under `metadata`, alongside the marker `metadata.source = 'session_send'`.

## Merge Semantics

`user_merge` redirects one user into another by moving identities and marking the old record's `merged_into`. Resolution follows merge links so old identities continue to map to the canonical user.

## Current Limits

- Role is per agent, not per session.
- Fine-grained session capability sets are not implemented; role filtering is the active permission model.
