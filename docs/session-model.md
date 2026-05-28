# Session Model

Sessions are durable conversation threads identified by `sessionId`. They are shared across CLI, web, API, channel adapters, and schedules.

## Session Sources

Each session has a source:

```ts
interface SessionSource {
  kind: 'cli' | 'api' | 'channel' | 'schedule' | string;
  interactive: boolean;
  platform?: string;
  triggerId?: string;
  type?: 'direct' | 'group';
}
```

Examples:

| Source | Session ID |
|--------|------------|
| CLI | `cli:{name}` |
| Web | `web:{deviceOrSession}` |
| Telegram | `telegram:{date}-{random}` with `telegram_chat_id` metadata |
| Discord | `discord:{date}-{random}` with `discord_channel_id` metadata |
| Slack | `slack:{date}-{random}` with `slack_channel_id` and optional `slack_thread_ts` metadata |
| Schedule | `schedule:{scheduleId}` |

## Status

| Status | Meaning |
|--------|---------|
| `idle` | Open and ready |
| `running` | A turn is executing |
| `awaiting_approval` | A tool call is paused for user approval |
| `inactive` | Hidden from normal lists, usually replaced by `/new` or stale |

Sessions are not permanently closed. They can be resumed later unless deleted.

## Persistence

The `sessions` table stores:

- source and metadata
- created/last-activity timestamps
- status
- message and completed-turn counts
- description and description source
- last message preview
- working memory
- session type
- participant user IDs

The `session_events` table stores the durable event log used for history, SSE backlog, and cross-client visibility.

## Opening And Resuming

`openSession()` creates a new session or reopens an existing one. Reopening preserves the original source and merges metadata. User identity is re-resolved on open so role changes and merges take effect.

For persisted sessions, non-owner users must already be participants. Owners can view all sessions.

## Message Handling

`postMessage()`:

1. clears idle introspection timers
2. updates status and preview metadata
3. resolves per-message sender identity when provided
4. persists the user message and emits `user_message`
5. applies group routing
6. queues an agent turn if triggered
7. emits model/tool events
8. schedules introspection when appropriate

`appendMessage()` stores the message and emits `user_message` without triggering the model.

## Group Routing

Group sessions use the same runtime rules for Telegram, Discord, and Slack:

- owner messages always trigger the agent
- non-owner mentioned messages trigger the agent
- non-owner unmentioned messages are logged but do not trigger
- owner messages that are not directed at the agent are prefixed for context so the model can choose whether to reply
- Silence markers (`<NO_REPLY>` plus the legacy `<EMPTY_RESPONSE>`) are stripped from agent responses by channel adapters; if the stripped remainder is empty the reply is suppressed entirely (whether a marker is emitted alone or alongside real text)

## Checkpoints

`checkpointSession()` runs introspection over events since the last introspection event. Reasons:

- `manual`
- `new_session`
- `turn_limit`
- `idle`

The introspection agent may update long-term memory, working memory, and session description.

## Deletion

Direct sessions can be deleted when they are not running. Group sessions are retained because they represent shared channel history.

## Access Control

Session access is participant-based for non-owners. `verifySessionAccess()` allows owners, then checks in-memory or persisted session participant IDs. Channel tokens are additionally constrained to their namespace prefix.
