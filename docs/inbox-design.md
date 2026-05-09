# Inbox Session

> **Status: Design / in progress.** Reference for PR B (post 0.6.8).

## Purpose

Each agent gets one **`inbox`** session that holds owner-attention items: async approval requests, future system notifications, errors needing acknowledgement. It is the canonical durable feed for "things the owner should look at" — separate from regular chat sessions so notifications never bleed into agent conversation context.

## Identity

- `sessionId = 'inbox'` (literal, no suffix)
- Per-agent uniqueness comes from the composite `(agentId, sessionId)` key on `session_events` and `sessions`. Each agent has exactly one inbox row.
- `source.kind = 'inbox'`, `source.platform = 'inbox'`, `source.type = 'system'`, `interactive = false`.

## Visibility

- **Owner only.** Members and guests cannot list, subscribe, or read the inbox.
- Admin bearer can access for support/debug.
- The session is hidden from the default `/sessions` listing unless the caller is the owner; web UI presents it via a dedicated route, not in the chat list.

## Read-only contract

- `POST /api/agents/{agentId}/sessions/inbox/messages` → `403 inbox_read_only`.
- WS `session.message` to inbox → same error.
- The inbox does not run an LLM turn. No agent reply is generated when entries are written.
- Writing to the inbox is a backend-only operation: `messageStore.appendLogEntry(scope, 'inbox', entry)`. Tools, channel adapters, and user-facing APIs cannot write.

## Read paths (all reuse existing infrastructure)

| Surface | Mechanism |
|---|---|
| Web UI feed | `GET /api/agents/{agentId}/sessions/inbox/messages` (history) + `GET /api/agents/{agentId}/sessions/inbox/events` (SSE live) |
| WS subscriber | `session.subscribe` with `sessionId: 'inbox'` |
| JWT-bearing third party | Same SSE/WS endpoints, owner JWT |
| Agent self-introspection | `session_read` tool with `sessionId: 'inbox'` — gated by the existing per-session visibility check (owner-only ⇒ only owner-triggered turns can read) |

No new endpoints or transports.

## Eager creation

When an agent is created (and as a one-time backfill for existing agents via migration), insert the inbox session row with no events. Eager creation guarantees:

- Web UI always has something to subscribe to (no "session not found" race on first load)
- Backend writers don't have to lazy-create inside hot paths

## Notification write path

```ts
async function notify(agentId, owner, content, metadata, actions) {
  // 1. Canonical: always write to inbox.
  await messageStore.appendLogEntry({ agentId }, 'inbox', {
    ts: now(),
    role: 'system',
    type: 'notification',
    content,
    metadata: { ...metadata, ...(actions ? { actions } : {}) },
  });
  await broker.publish({
    type: 'notification',  // new wire event (additive)
    sessionId: 'inbox',
    ...
  });

  // 2. Secondary best-effort push: session_send-style fan-out to configured channels.
  for (const channel of agent.config.notifications?.channels ?? []) {
    const targetSession = await findOwnerSessionOnChannel(agentId, owner, channel);
    if (!targetSession) continue;            // owner not yet on this channel — skip silently
    const adapter = channelOutbounds[channel];
    if (!adapter) continue;
    await adapter.send({ sessionId: targetSession, to: targetSession.to, text: content, actions });
  }
}
```

The current `notifyOwnerApproval` is rewritten on top of this `notify` helper.

## Approval flow under inbox

### Async approval request

1. Non-owner requests resource → `approval_requests` row created (status `pending`)
2. Existing wire event `approval_requested` (mode=`async`) emitted into requester's session (unchanged)
3. **New:** `notify()` writes a card entry to inbox with `metadata.actions = [{ type: 'approval_review', requestId, shortId }]` and emits the new `notification` wire event into inbox
4. Secondary push to configured channels (Telegram etc.) via existing `session_send` path

### Async approval resolve

When `approval_review` runs (owner clicks button anywhere — web inbox, Telegram inline keyboard, etc.):

1. `approvalRequestStore.resolve(...)` (existing)
2. Existing fan-out emits `approval_resolved` (mode=`async`) to requester's session (unchanged)
3. **New:** also emit `approval_resolved` to `inbox` session and write the corresponding log entry, so the inbox UI marks the card done. Other open inbox subscribers see the same event and update.

### Realtime approvals

Stay entirely inside the requester's session. Inbox is **not** involved — realtime approval is owner-in-session, no notification needed.

## Wire protocol additions

Additive (non-breaking):

```ts
| {
    type: 'notification';
    sessionId: 'inbox';
    role: 'system';
    content: string;
    metadata?: Record<string, unknown>;
  }
```

`approval_resolved` already exists; just gains an additional fan-out target (`sessionId: 'inbox'`).

## Agent config

```ts
{
  notifications?: {
    channels?: string[];   // optional secondary push targets, e.g. ['telegram']
  }
}
```

Default `channels = []` → only inbox. inbox itself has no opt-out (it's the canonical sink).

## Migration `0022_inbox_sessions.sql`

```sql
INSERT INTO sessions (agent_id, session_id, source, metadata, created_at, last_activity_at)
SELECT agent_id, 'inbox',
  jsonb_build_object('kind', 'inbox', 'platform', 'inbox', 'type', 'system', 'interactive', false),
  '{}'::jsonb,
  now(), now()
FROM agents
ON CONFLICT (agent_id, session_id) DO NOTHING;
```

Plus, on the agent-create path (gateway side), eagerly insert the inbox row.

## Web UI

> **Status: deferred.** Backend (inbox row + `approval_pending`/`approval_resolved` fan-out + read-only enforcement) ships first. The existing `ApprovalsPanel` already covers async approval review via the approval store API; a dedicated inbox feed view is a follow-up PR.

Planned shape:

- New route `/agents/:agentId/inbox`
- Sidebar icon with unread badge (count of inbox entries with no `seenAt` marker — separate from chat sessions)
- Cards rendered from `metadata.type` (notification / approval / etc.) and `metadata.actions` array
- No composer
- Resolved cards auto-collapse / mute after `approval_resolved` arrives

## Out of scope (deferred)

- Cross-agent inbox aggregation (UI can fetch multiple agents' inboxes; backend stays per-agent)
- Per-user channel preferences (today's `notifications.channels` is per-agent; future could add `users.notification_channels`)
- Inbox composer / chat-in-inbox (read-only by design; "discuss" escape hatch can be added later by spawning a new chat session seeded with the notification context)
- Snooze, dismiss, mark-as-read affordances (start with simple resolved/unresolved)
- Rate limiting / batching of notifications (write-each for now)

## Compatibility

- Existing agents: backfilled by migration
- Existing approval flows: realtime path unchanged; async path gains the inbox fan-out (additive)
- Existing channel adapters: unchanged (they keep using `ChannelOutbound.send` with `actions`)
- SDK consumers: new `notification` wire event added to `OutboundEventBody` union — handle or ignore
