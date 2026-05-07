# Lazy Hydration & Multi-Tenant Scaling Design

**Status:** Phases 1–5 shipped on `main`. Two items in the original Phase 4 list (per-bot multi-agent routing, channel-state externalization to Postgres) turned out not to be required under the single-gateway / one-bot-per-agent model and are dropped from scope; see Phase 4 #4–#5.
**Goal:** Support 1000–2000 agents per gateway instance on a 64 GB Railway container

---

## Background (historical — pre-refactor)

Before this work the gateway eagerly hydrated every agent at boot:

- `apps/gateway/src/index.ts` iterated every row in `agents` on startup (under `autoStartAgents=true`) and called `instances.start()`.
- `AgentInstanceManager.runners: Map<agentId, AgentRunner>` was populated forever; there was no idle eviction, no LRU, no TTL.
- Per-agent in-process resources held by the runner: scheduler timers, MCP client connections, channel adapters (Slack Socket Mode WebSocket, Discord WebSocket, Telegram polling loop), session event broker, workspace/container manager.

Per-agent baseline ≈ 6–15 MB. With 1000–2000 agents this is 10–20 GB of always-hot memory plus full event-loop pressure even when most agents are idle.

## Target Architecture

```
┌─ Gateway (long-lived) ──────────────────────────────────┐
│                                                         │
│  • agents.status read-through (DB is source of truth)   │
│  • Runner LRU cache + idle eviction                     │
│  • Single-flight hydration (Map<agentId, Promise<R>>)   │
│  • Central cron scheduler (scans schedules.next_run_at) │
│  • Channel connection pool                              │
│      - Telegram: webhook routing + polling loop pool    │
│      - Slack:    Socket Mode connection pool            │
│      - Discord:  Gateway WebSocket connection pool      │
│  • Inbound router → hydrate-on-demand                   │
│                                                         │
└─────────────────────────────────────────────────────────┘
              ↓ hydrate when needed
        AgentRunner (short-lived, LRU)
        • Session + Claude streaming
        • MCP clients (loaded async; observable status)
        • Tool execution
        • Workspace / container
```

### Core principle

`agents.status` (DB column, source of truth) determines whether the gateway accepts requests for an agent. The in-memory `runners` Map is purely a hydration cache — its presence is an optimization, never a policy decision.

```
request arrives
  ↓
runners.get(agentId)?
  ├─ present → handle directly
  └─ absent  → SELECT status, config_json, security_json, workspace_dir
                FROM agents WHERE agent_id = ?
                ├─ active   → hydrate runner, handle
                ├─ disabled → 403
                └─ missing  → 404
```

## Design Decisions

### 1. `agents.status` column (replaces in-memory start/stop)

```sql
ALTER TABLE agents ADD COLUMN status text NOT NULL DEFAULT 'active';
-- 'active' | 'disabled'
```

- Single source of truth; survives gateway restart with no recovery state.
- `PATCH /api/agents/:id { status: 'disabled' }` updates DB, then in-process actively evicts the runner if hot.
- Multi-gateway later: pub/sub via Postgres `LISTEN/NOTIFY` to broadcast disable events. Out of scope for v1.
- Migration must be registered in `packages/store/drizzle/meta/_journal.json` (drizzle silently skips unregistered migrations).

### 2. Lazy hydration with single-flight

- `runners` map stores `Promise<Runner>` (not `Runner`) so concurrent requests for a cold agent share one hydration.
- Idle TTL (default 30 min). A periodic ticker evicts runners whose `lastActivityAt` is older than the TTL **and** which have no active sessions / WS subscribers / in-flight work.
- Hydration cost budget: DB read + AgentRunner construction + (deferred) MCP. The sandbox/container is already lazy-provisioned on first `exec` or file I/O, so it does not contribute to hydration latency. With async MCP loading, cold start is sub-second; the first tool call that touches the sandbox pays the existing provision cost (unchanged from today).

### 3. Central cron scheduler

The `schedules` and `schedule_runs` tables already exist (`packages/store/src/schema.ts:287-325`) with all needed fields: `cron_expression`, `next_run_at`, `last_run_at`, `status`, `consecutive_errors`, `run_count`. Index `idx_schedules_next_run` on `(agent_id, next_run_at)` already supports the central scan.

What changes:
- Remove the per-runner `Scheduler` instance from `apps/agent/src/agent-runner.ts:216`.
- Add a single gateway-level `CentralScheduler` that scans `schedules WHERE status='active' AND next_run_at <= now()` every N seconds.
- On hit: hydrate the agent → fire one schedule run → update `last_run_at` / `next_run_at` / `consecutive_errors` → optionally evict if no other activity.

Side benefits:
- Catchup semantics on gateway restart become explicit (rows with overdue `next_run_at` are visible in the DB; current `setInterval` model loses these silently).
- Central observability: schedule runs, failures, retries all flow through one code path.

### 4. MCP async loading

- Runner becomes responsive without waiting for MCP servers to connect.
- Tool list is dynamic: connected MCP tools are merged in as connections come up.
- Agent has visible MCP connection state (e.g. agent can answer "the GitHub MCP server is still connecting, try again in a moment").
- On rehydration after eviction, reconnect cost is paid once on first tool call (acceptable).

This is independently valuable beyond lazy hydration: it also fixes "one bad MCP server kills the entire agent boot" today.

### 5. Channel connection pooling

All three channel adapters currently hold per-agent in-process state and (for Slack/Discord/Telegram-polling) a per-agent persistent connection. This blocks lazy eviction. Channel adapters get refactored so the **connection holder lives in the gateway**, independent of any runner.

#### 5.1 Telegram

Keep both webhook and polling modes.

- **Webhook**: already gateway-routed via `/api/agents/:agentId/channels/telegram/webhook` (`apps/gateway/src/app.ts:2031-2048`). No changes.
- **Polling**: move the `getUpdates` loop out of the runner into a gateway-level pool: `Map<botToken, PollLoop>`. Loop runs regardless of runner state; on each batch, route updates → hydrate agent → dispatch.

Webhook is preferred for memory efficiency; polling stays available for deployments without a public URL.

#### 5.2 Slack

Keep Socket Mode for now. Move the `SocketModeClient` from per-runner to gateway-level pool: `Map<appToken, SocketModeClient>`. Inbound events route via `(team_id, channel_id) → agent_id` lookup → hydrate → dispatch.

If per-tenant bots scale poorly (one socket per agent), a future migration to Slack Events API (HTTP webhook) can be considered. Out of scope for v1.

#### 5.3 Discord

Discord has no inbound webhook mechanism — Gateway WebSocket is mandatory. Same pattern: gateway-level pool `Map<botToken, DiscordClient>`, inbound `MessageCreate` → routing table → hydrate.

**Open question:** Is a Discord bot per-agent, or do multiple agents share one bot? This determines whether Discord is the scaling ceiling.

#### 5.4 Channel state externalization

Per-agent in-memory state currently held by adapters must move to Postgres so it survives runner eviction:

- `chatSessions` (Telegram), `channelSessions` (Slack/Discord) — in-flight conversation state
- `lastEventIds` — SSE dedup cursors
- `pendingApprovals`, `pendingAsyncApprovals` — approval flow state
- `chatLocks`, `turnQueues` — serialization primitives (these become DB-backed advisory locks or rely on agent-level single-flight)

This is the largest hidden cost of Phase 4 — bigger than the connection pooling itself.

### 6. Remove `autoStartAgents`

Once lazy hydration, central cron, and channel pooling are in place, `autoStartAgents` has no purpose. **Drop it entirely** in the same branch (Option A — no transitional flag, no deprecation period). Since all phases ship together, there is no window where socket-mode channels need a runner kept alive.

## Memory Projection (64 GB container, post-refactor)

Assumptions: idle TTL 30 min, ~5 % of agents active in a 30 min window, average hot runner ~30 MB (with sessions + MCP).

| Total registered agents | Hot runners | Memory |
|------|------|------|
| 1000 | ~50  | ~1.5 GB |
| 2000 | ~100 | ~3 GB |
| 5000 | ~250 | ~7.5 GB |

64 GB easily supports 5000–10000 registered agents under this profile, plus headroom for connection pools, Node heap, and traffic bursts.

## Implementation Plan

### Prerequisite — MCP async loading ✅ shipped

Lives in `apps/agent/src/mcp-client.ts`. Independently valuable — fixed "one bad MCP server stalls agent boot" and slow gateway startup. Required for sub-second cold hydration.

1. ✅ `connectAll()` is fire-and-forget; runner construction does not await MCP `connect()`.
2. ✅ Each client connects in the background; `getToolsets()` filters on `status === 'connected'` so the tool surface grows as connections complete.
3. ✅ `getStatus()` exposes per-server `'connecting' | 'connected' | 'disconnected' | 'error'` plus `lastError` / `connectedAt`.
4. ✅ Tool calls on a still-connecting server return `"MCP server … is still connecting. Try again in a moment."`

### Lazy-hydration branch

One long-lived feature branch `feat/lazy-hydration` off `main` (after the MCP async PR is merged). All phases below land together; no partial merges.

### Phase 1 — `agents.status` + lazy hydration (HTTP / WS / webhook) ✅ shipped

1. Migration: add `agents.status` column (register in `_journal.json`).
2. Schema: update `packages/store/src/schema.ts`.
3. Store: add `getStatus` / `setStatus` to `agentStore` (or surface via existing `get`).
4. `AgentInstanceManager.getOrHydrate(agentId)` — if absent, look up DB; if `active`, start; cache `Promise<Runner>` for single-flight.
5. Replace `resolveRunner` call sites in HTTP / WS / webhook handlers with `getOrHydrate`.
6. `PATCH /api/agents/:id { status }` endpoint; on transition to `disabled`, actively `instances.stop(agentId)` in-process.

### Phase 2 — Central cron scheduler ✅ shipped

1. `CentralScheduler` in gateway scans `schedules` every 10 s
   (`apps/gateway/src/central-scheduler.ts`).
2. On hit: `getOrHydrate(agentId)` → `runner.runScheduledJob(schedule, sessionId)` → mark row.
3. Per-runner `Scheduler` removed; `runScheduledJob` is the runner's only
   public scheduling surface.
4. Cron `next_run_at` is computed lazily — bootstrap pass on each tick
   handles rows where `next_run_at IS NULL`. Catchup across gateway
   restart is automatic (overdue rows are simply due).
5. Trade-off: cron precision drops to one tick interval (~10 s) —
   accepted for v1; in-process Cron timers can be re-added later if a
   specific schedule needs sub-second precision.

### Phase 3 — LRU eviction ✅ shipped

1. `AgentInstanceManager` tracks `lastActivityAt` per agent. `touch()` is called from `_doStart`, `getRunner` (read-touch), `getOrHydrate` cache hits, `dispatchWebhook`, and each WS message.
2. Eviction ticker scans hydrated runners every 60s; agents idle past `OPENHERMIT_EVICTION_TTL_MINUTES` (default 30) are stopped.
3. Skip-guards: agents with active channel handles (telegram/slack/discord polling), live WS connections, or non-zero `busy` counter are kept warm.
4. Long-running ops wrap themselves in `withBusy(agentId, fn)`; central scheduler does this around `runScheduledJob` so jobs that exceed the TTL aren't evicted mid-run.
5. `OPENHERMIT_EVICTION_TTL_MINUTES=0` disables eviction.

### Phase 4 — Channel connection pooling

1. ✅ Telegram polling loop moves to gateway-level pool (`apps/gateway/src/channel-pool.ts`, PR #29).
2. ✅ Slack Socket Mode client moves to gateway-level pool.
3. ✅ Discord client moves to gateway-level pool.
4. 🚫 **Out of scope.** A `(channel_kind, connection_id, conversation_id) → agent_id` routing table was on the original list to support multiple agents sharing one bot. In the actual product, each agent owns its own Telegram/Slack/Discord credentials (rows in `agent_channels`), so routing is 1:1 and already handled by `ChannelRegistry.register({apiKey, agentId})` in the pool. No use case in v1.
5. 🚫 **Out of scope.** Externalizing per-agent channel state to Postgres turned out to be unnecessary on inspection:
   - `chatSessions` / `channelSessions` are pure memoization — on cache miss the bridge falls back to `client.listSessions({metadata})` which already reads from the persisted `sessions` table (`apps/channels/{slack,discord,telegram}/src/bridge.ts`).
   - `lastEventIds` is the SSE dedup cursor, reset across runner restart via the `ready` / `nextEventId` frame (PR #29).
   - `pendingApprovals` (Telegram realtime) is valid only for the duration of one in-flight turn — that turn is in-memory by nature, so persisting the map is meaningless.
   - Async approvals already persist via `approval_requests.short_id` (PR #28).
   - `chatLocks` / `turnQueues` are per-conversation in-process mutexes; correct as in-memory under single-gateway. Multi-gateway HA is explicitly out of scope (see Open Questions §4) and would require its own design pass anyway.

### Phase 5 — Cleanup ✅ shipped (PR #30)

1. ✅ Deleted `autoStartAgents` config and the boot-time iteration in `index.ts`.
2. ✅ Updated `apps/gateway/README.md` and `docs/architecture.md`. (Other doc passes done as needed.)
3. ⏸ Formal end-to-end load test (100+ agents hydrating concurrently) not run; smoke-tested manually on test.openhermit.ai.

## Open Questions

1. **Discord bot deployment model** — per-agent independent bot, or multiple agents sharing one bot? Determines Discord scaling ceiling.
2. **Channel state backend** — Postgres (assumed default) vs Redis. Postgres preferred unless contention shows up in load testing.
3. **Branch strategy** — long feature branch will drift from `main`. Either freeze `main` to critical fixes only during the refactor, or rebase periodically. Need to pick one.
4. **Disable propagation across multiple gateways** — out of scope for v1 (single-gateway deployment); revisit when multi-gateway lands.

## Risks

- **Cold-start latency** on hydration is dominated by AgentRunner construction and DB reads (sandbox provisioning is already lazy and unchanged). MCP async loading keeps this sub-second. Per-agent "warm" pinning can be added later if specific latency-sensitive agents need it.
- **Channel state migration** is invasive — existing in-flight approvals and dedup cursors must be migrated, not just truncated.
- **Long-lived feature branch** risks merge conflicts. Mitigation: rebase weekly, keep phases independently testable.
- **Cron drift across restart** — central scheduler must implement a clear catchup policy (run-once-on-recovery vs skip-overdue) and document it.
