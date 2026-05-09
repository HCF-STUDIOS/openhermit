# Changelog

## 0.6.5 — 2026-05-09

### Breaking: outbound event identifiers (#51)

The `messageId` field on outbound events `text_delta`, `text_final`, `thinking_delta`, `thinking_final`, `tool_call`, and `tool_result` was misnamed: every event in a turn carried the same value (the inbound user-message id), so consumers persisting events by `messageId` hit unique-key collisions.

- **Renamed** `messageId` → `correlationId` on those six events. Same semantics: the inbound user-message id that triggered the turn.
- **Added** `eventId: string` to every outbound event. Per-event unique (UUID) — minted by the runtime. Use this for persistence dedup.
- SDK consumers reading the event stream must update field references (`event.messageId` → `event.correlationId`, plus optionally use `event.eventId`).

Released as a patch since the SDK is still in 0.x and the misnamed field shipped only one patch ago in 0.3.3.

`SessionMessage.messageId` (inbound), `ChannelOutboundResult.messageId`, and `channel_message_sent.messageId` are unchanged — those are unrelated identifiers.

---

## 0.6.2 — 2026-05-07

### Lazy hydration of agents (#23, #24, #25, #26, #30)

The gateway no longer eagerly starts every agent at boot. Agents are now hydrated on first access, gated by a per-agent `hydrating` map that fences `start()` against double-start races. A central cron scheduler (Phase 2) keeps scheduled work running for cold agents, an LRU eviction policy (Phase 3) reclaims idle runners, and the legacy `autoStartAgents` config has been removed in favour of fully lazy hydration.

### Channel bridge connection pool (#29)

Per-agent channel bridges (Slack/Discord/Telegram) are hoisted into a shared connection pool, so multiple agents on the same workspace share a single upstream connection instead of each opening their own.

### Async approval callback persistence (#28)

Channel approval requests now persist their callback ID via `approval_requests.short_id`, so async approvals survive gateway restarts.

### Fixes

- **agent:** auto-ensure sandbox in the e2b and daytona file backends so file ops don't fail against a cold sandbox (#27).
- **web:** show DB status on the agent picker and block clicks on disabled agents (#31).

### Performance

- **mcp:** connect MCP servers asynchronously so a slow server no longer blocks agent boot (#22).

---

## 0.6.1 — 2026-05-07

### Gateway config moved to the database

Gateway-level configuration (CORS, auto-start agents, sandbox presets, auto-provision target) is now stored in the `meta` table instead of `~/.openhermit/gateway/gateway.json`. On first boot, an existing `gateway.json` is migrated into the DB and renamed to `gateway.json.imported`. New `hermit gateway config get/set/show` commands and a **Config** tab in the admin UI let operators edit the live config; changes require a gateway restart to apply.

### Security hardening (#14)

- Admin bearer-token comparison now uses `crypto.timingSafeEqual` to prevent timing attacks.
- `jwtVerify` is pinned to `HS256` to block algorithm-confusion attacks.
- Markdown rendered in chat messages is now passed through DOMPurify before `dangerouslySetInnerHTML`.

### Performance (#15)

- Eliminated N+1 user lookups in fleet/agent endpoints (batched `UserStore` methods).
- Boot is parallelized: agent runners and channel starts kick off concurrently, and sandbox `listAll` is bucketed across providers.
- Added a GIN index on `sessions.user_ids` (migration `0015_sessions_user_ids_gin.sql`).
- Web UI bundle is code-split via `manualChunks` + `React.lazy` on `ChatShell` / `ManagePanel`; initial JS dropped from ~363 KB to ~207 KB.

### Web UI: self-service token + restore flow (#18)

- New **Show access tokens** panel on the agent picker exposes the JWT bearer token and the device key (with copy buttons and warning) — no more digging through devtools.
- New **Restore from key** mode on the welcome screen accepts an exported device key JSON to recover access on a fresh browser.
- Renamed the per-agent join field from "Access Token" to "Agent invite token" with help text to stop the JWT/invite mix-up.

### SDK (#16)

- `GatewayClient.registerMcpServer()` wrapper around `POST /api/admin/mcp-servers`.

### UI fixes (#19)

- `/admin/config` panel: replaced undefined `.form-row` classes with the existing `.field` pattern so fields stack vertically.
- Added spacing between **Show access tokens** and **Sign out** on the agent picker.

---

## 0.6.0 — 2026-05-06

### Policy v2: unified effect model + approval flow

The access policy system now supports three effects per policy row: `allow`, `deny`, and `require_approval`. This replaces the previous `autonomy_level` / `require_approval_for` fields in SecurityPolicy with a single, composable mechanism.

**Effect evaluation** follows deny > require_approval > allow precedence (AWS IAM style). When policy rows exist for a resource but none match the calling principal's grants, access is denied — no silent fallthrough.

**Approval flow** supports two modes:

- **Real-time approval**: when the owner is in an interactive session, a UI prompt appears inline (ApprovalGate). The owner approves or rejects without leaving the conversation.
- **Async approval**: when the requester is on a different channel (e.g. Telegram guest), an `ApprovalRequest` is persisted and the owner is notified on their configured channel with approve/reject buttons. The agent tells the user to wait for owner approval and stops attempting workarounds.

Approved requests are cached with a configurable TTL (default 60 minutes). Owners can choose `persistent` resolution to auto-create a permanent allow policy row for the requester.

**ToolPolicy simplified**: the previous `{ kind: 'fixed', grants } | { kind: 'configurable', defaultGrants }` union is replaced by a single `{ defaultGrants: Grant[] }` interface. All tools are now overridable via DB policy rows — there is no longer a "fixed" category that ignores the policy table.

**Default grants tightened**:

| Tool | Old default | New default |
|------|------------|-------------|
| `exec` | owner + user | owner only |
| `file_write`, `file_edit`, `file_delete` | owner + user | owner only |
| `schedule_create/update/delete/trigger` | owner + user | owner only |
| `file_read`, `file_list`, `file_stat` | owner + user | owner + user (unchanged) |

**File and exec policy scopes** are now populated at creation time with structured fields (`{ sandbox, mode, path }` for files, `{ sandbox, command, cwd }` for exec) instead of relying on fallback matching at evaluation time.

**Channel identity forwarding**: channel-authenticated API calls (e.g. Telegram bridge reviewing an approval) can now pass `x-channel-user-id` header so the gateway resolves the acting user's identity for authorization.

### Breaking changes

- `ToolPolicy` type changed from a discriminated union to `{ defaultGrants: Grant[] }`. All tool definitions updated.
- `evaluateAccess` returns `'deny'` (not the default decision) when policy rows exist but no grant matches the principal. Previously this allowed guests to bypass owner-only tools.
- `autonomy_level` and `require_approval_for` in SecurityPolicy are deprecated. They still work as syntactic sugar (synthesized into virtual policy rows at runtime) but new deployments should use policy rows directly.

---

## 0.5.2 — 2026-05-05

### Fixes

- `hermit --version` now reads from `package.json` instead of a hardcoded string.

---

## 0.5.1 — 2026-05-05

### First-class filesystem tools

Six new tools (`file_read`, `file_write`, `file_edit`, `file_list`, `file_stat`, `file_delete`) give agents direct filesystem access inside their sandbox, replacing the previous pattern of shelling out via `exec`. `file_read` supports line ranges (`offset`/`limit`), and `file_edit` provides find-and-replace semantics. All three sandbox backends (host/docker bind-mount, E2B, Daytona) are supported.

### Cross-channel identity link

Users can now link their identities across channels (Telegram, CLI, web, Discord) via `identity_link_request` / `identity_link_confirm` tools. A token generated on one channel can be confirmed on another to merge the accounts. Ghost users created during the link flow are absorbed into the confirmed identity.

### Security: symlink escape detection

`HostFileBackend` (used by the `host` and `docker` backends) now resolves all paths through `realpath` before performing I/O, then re-checks the resolved path falls within the sandbox root. This prevents agents from escaping the workspace via symlinks.

### Fixes

- Identity tools now register for guest users on Telegram (channel info is threaded through `refreshAgentConfiguration`).
- Identity link tool descriptions improved for discoverability with weaker models.
- `file_write` overwrite mode no longer uses atomic temp+rename (which broke on cross-device mounts).
- System prompt now directs agents to prefer file tools over exec for file operations.
- Discord channel turn serialization fixed (#12), runtime dependency bundling fixed (#11).

### Refactor

- `exec-backend.ts` (1385 lines) split into `core/backends/` folder: `docker.ts`, `host.ts`, `e2b.ts`, `daytona.ts`, `file-backend.ts`, `shared.ts`.

### Docs

- `tools.md` and `fs-tools.md` updated with all new tools.
- Access policy proposal and sandbox model docs refreshed.

---

## 0.5.0 — 2026-05-04

### Sandboxes are first-class

Sandboxes used to live inside each agent's config as `exec.backends[]`. They are now stored as rows in a `sandboxes` table, with their own lifecycle (`pending` → `provisioned` → `deleted`), per-row `runtime_state` for cross-restart reconnection, and a per-agent `(agent_id, alias)` partial-unique index that allows re-using an alias after soft-delete.

The runtime constructs each agent's `ExecBackendManager` from these rows; the legacy `exec.backends[]` path remains as a fallback when no rows exist (mid-backfill or sandbox store unavailable).

### Sandbox presets in `gateway.json`

`autoProvisionSandbox` is no longer an inline `{ enabled, type, config }` object — it now references a named preset:

```json
{
  "sandboxPresets": {
    "docker-ubuntu":   { "type": "docker",  "config": { "image": "ubuntu:24.04", "username": "root", "agent_home": "/root" } },
    "e2b-default":     { "type": "e2b",     "config": { "template": "base" } },
    "daytona-default": { "type": "daytona", "config": {} }
  },
  "autoProvisionSandbox": "docker-ubuntu"
}
```

**Breaking** — gateways carrying the legacy shape will refuse to start with a clear migration message. Move the inline config into `sandboxPresets[<name>]` and set `autoProvisionSandbox: "<name>"`.

`POST /api/agents` (and the admin UI's create-agent dialog) accept a new `sandbox` field:

- omitted → use the gateway's `autoProvisionSandbox`
- `"<preset>"` → provision that preset
- `null` → skip sandbox provisioning entirely

`GET /api/sandbox-presets` returns the registry to authenticated users so frontends can populate dropdowns.

### Daytona backend

New `daytona` backend type alongside `host` / `docker` / `e2b`. Set `DAYTONA_API_KEY` in the gateway env, then pick `daytona` as a preset type or pass `--type daytona` to `hermit sandbox add`. Archived sandboxes (idle 7d+) are recovered transparently on `ensure()` via `start()`.

### Access policy enforced end-to-end

The `access` field on the agent's security policy (`public` / `protected` / `private`) is now enforced at session-open time:

- A sender with no membership row on a non-public agent is rejected (404) **before** any message is processed.
- Globally-known users (registered via another agent on the gateway) no longer auto-claim a guest role on `private` / `protected` agents — they must be added explicitly via `/members`.
- The create-agent dialog gained an Access dropdown so operators can pick the level at create time.

### Sandboxes admin tab

The admin UI's `Containers` tab is now `Sandboxes` and reads from the `sandboxes` table directly, overlaying live `docker ps` runtime info for docker rows (`—` when the container isn't on this host).

### Misc

- `host` backend now enforces single-instance-per-gateway at the API layer (was previously enforced inside the backend).
- Soft-deleted sandbox aliases can be reused immediately (partial unique index migration `0009`).
- New CLI flags: `hermit agents create --sandbox <preset>` / `--no-sandbox`.

---

Earlier history: see git tag list (v0.4.16 and prior).
