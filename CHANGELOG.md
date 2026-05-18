# Changelog

## SDK 0.5.1 — 2026-05-18

- **Added** `AgentLocalClient.uploadAttachment` / `listAttachments` / `getAttachment` — the same per-session attachment surface that `GatewayClient` already exposed, but on the per-agent client, so callers holding a channel-mode token (not an admin token) can upload directly under `/api/agents/:id/sessions/:sid/attachments`. Server-side auth is unchanged: same `requireAuth` → `enforceSessionNamespace` → `requireSessionAccessHttp` chain that `postMessage` uses, so any token that can `postMessage` on a session can also `uploadAttachment` to it.
- **Added** `SessionAttachment` and `AttachmentMaterializationState` to the package's top-level exports so downstream consumers no longer need to mirror them locally or recover them via `Awaited<ReturnType<...>>`.
- **Added** `agentLocalRoutes.sessionAttachments(sessionId)` / `sessionAttachmentById(sessionId, attachmentId)` (plus their `*Pattern` siblings) in `@openhermit/protocol`, mirroring the existing `gatewayRoutes.agentSessionAttachments*` entries.

## 0.8.0 — 2026-05-18

### File attachments end-to-end

Agents now have first-class file attachments. Users upload files in the web composer, attachments are persisted by a pluggable `AttachmentStorage` backend, and the bytes are materialized into the agent's sandbox so tools can `file_read` them by path.

- **Added** `session_attachments` table + `DbAttachmentStore` with `originalName`, `safeName`, `mimeType`, `sizeBytes`, `sha256`, `materializationState` (`pending` / `copied` / `failed`), and sandbox path (#110).
- **Added** `AttachmentStorage` interface and `LocalAttachmentStorage` provider (#110). S3 and Supabase providers followed in (#116), gated by optional peer deps (`@aws-sdk/client-s3`, `@supabase/supabase-js`).
- **Added** `POST/GET /api/agents/:id/sessions/:sid/attachments` endpoints with multipart upload, MIME sniffing via magic bytes, and 25 MB default cap (#115). Every successful upload is materialized into the sandbox at `~/.openhermit/attachments/<session>/<attachment>/<safeName>`.
- **Added** `attachment_fetch` tool, multimodal user messages, web composer drag/drop+paste support, and SDK upload helpers (#117).
- **Changed** materialization policy to always-on with lazy self-heal (#118). When the sandbox is down at upload time the row is marked `failed`; on first `attachment_fetch` the tool re-materializes from storage. The previous `sandboxCopyMaxBytes` threshold and `'skipped'` state were removed.

### Gateway config UI: Settings + JSON tabs

The admin Gateway Config panel grew a JSON tab alongside Settings. The JSON tab shows the full DB-stored config as editable JSON so fields the form doesn't expose (e.g. `attachments.storage`) can be edited from the UI without shell access. Switching tabs re-derives the destination view from the last applied config, so unsaved edits don't silently leak across tabs.

### Breaking: env vars are for secrets only

Non-secret attachment env vars were dropped — provider selection and non-secret resource pointers must now live in the DB-backed gateway config under `attachments.storage`.

- **Removed** `OPENHERMIT_ATTACHMENT_PROVIDER`, `OPENHERMIT_ATTACHMENT_S3_BUCKET` / `_REGION` / `_PREFIX` / `_ENDPOINT`, `OPENHERMIT_ATTACHMENT_SUPABASE_URL` / `_BUCKET` / `_PREFIX`, `OPENHERMIT_ATTACHMENT_ROOT`, `OPENHERMIT_ATTACHMENT_MAX_BYTES`.
- **Kept (env-only)** AWS default chain (`AWS_ACCESS_KEY_ID`/etc.), `SUPABASE_URL` (project URL embeds the project ID — treated as part of the credential bundle), `SUPABASE_SERVICE_ROLE_KEY`.
- Deployments that relied on the env fallbacks must add an `attachments.storage` block to gateway config before upgrading or fall back to local-disk storage on restart.

### Fleet usage analytics

Token usage and cost views surfaced in the Fleet and Stats panels (#100). The per-session Usage modal split into Overview / By model / Daily tabs (#105). Partial index on `session_events` added so the aggregation query stays cheap as event volume grows (#103). Fixes for the aggregation SQL (#101, #102) and time-tab scope (#104).

### Channels

- **Added** `hermit channel install / uninstall / list` for managing channel plugin packages (#95).
- **Added** public gateway URL config, channel auto-start, and persisted runtime errors so a misconfigured channel doesn't take down boot (#107).
- **Added** runtime error reporting from bots back to the channel layer (#108).
- **Fixed** Telegram realtime approval review now passes `channelUserId` so the gate resolves the acting user (#106).

### Fixes

- **agent:** promote thinking to text when `stopReason=toolUse` with no tool_use blocks (#111).
- **agent:** don't duplicate the new user message on the first turn after resume (#109).

---

## 0.7.0 — 2026-05-15

### Channel plugin contract

Channels are now plugins. Each channel — built-in or external — provides a `ChannelManifest` describing its config schema, secret keys, capabilities, and setup steps. The gateway loads built-in channels through the manifest registry on boot, and external channel packages can be loaded by listing them under `channelPackages` in the gateway config.

- **Added** `ChannelManifest` + `ChannelManifestRegistry` in `@openhermit/protocol` (#87).
- **Refactored** built-in channels (Telegram / Slack / Discord) to register via the manifest registry (#88).
- **Added** interactive setup contract for multi-step channel flows (QR scan, OAuth) so plugin channels can drive setup from the admin UI without hardcoded per-channel code (#90).
- **Added** `channelPackages` gateway config: each entry is an npm package name, dynamic-imported at boot, whose default export must be a `ChannelManifest`. External packages may override a built-in by matching its key (#94).

### @openhermit/channel-wechat (text-only v0)

First external channel plugin published to npm (#91, #93). Connects to WeChat via iLink (browser scan + persistent session), text-only for v0. Install with `npm install @openhermit/channel-wechat`, then add the package name to `channelPackages` in gateway config and restart the gateway.

### Docs

- New user-facing manual (#84, #85) covering identity / soul / rules sections and the everyday agent workflow.

---

## 0.6.8 — 2026-05-09

### Breaking: drop `channel_message_sent`

Proactive sends from `session_send` were recorded as a synthetic `channel_message_sent` log entry whose `text` field made the row invisible to LLM history replay (which keys off `content`). The wire `OutboundEvent.channel_message_sent` type existed in the protocol but was never published. Both have been removed.

- **Removed** `channel_message_sent` from `OutboundEventBody` (wire). Zero publishers, zero subscribers — pure dead code.
- **Changed** `session_send` to record deliveries as a normal assistant log entry: `{ role: 'assistant', content: text, metadata: { source: 'session_send', fromSession, channel, to, messageId } }`. The receiver session's LLM history replay now sees proactive sends as ordinary assistant turns.
- **Added** explicit `metadata?: Record<string, unknown>` slot on `SessionLogEntry`. Existing `[key: string]: unknown` permits it; this just documents the convention so future derivative fields land in `metadata` instead of scattering at the entry root.
- Migration `0021_drop_channel_message_sent.sql` rewrites existing rows in place: `event_type` becomes `'assistant'`, `text` is folded into `content`, delivery details move under `payload.metadata`.

Released as a patch since the SDK is still in 0.x.

---

## 0.6.7 — 2026-05-09

### Breaking: unified approval event naming

Approval-related events used a mix of legacy tool-specific and new resource-based names. Cleaned up to a single set:

- **Removed** `tool_approval_required` (wire). Consumers must listen for `approval_requested` with `mode === 'realtime'` and read the tool name from `resourceKey` (instead of `toolName`).
- **Added** `approval_resolved` (wire) — fires when a request is resolved, in both realtime (after the gate decides) and async (after the owner runs `approval_review`) modes. Carries `decision`, optional `resolution`, and `reviewerId`.
- `approval_pending` is now `mode: 'async'` only — realtime mode no longer emits a redundant pending event (requester is the same as the reviewer).
- DB `session_events` rows previously written as `tool_approval_requested` / `tool_approval_resolved` are now written as `approval_requested` / `approval_resolved`. Migration `0020_approval_event_rename.sql` renames existing rows. The DB payload is also generic (`resourceType`, `resourceKey`, optional `toolCallId`) instead of tool-specific.
- Async non-tool resources (file/exec/etc.) now also persist `approval_requested` / `approval_resolved` to the requester's `session_events` for audit symmetry. Previously only the tool-specific path wrote DB rows.
- `approval_pending` continues to be wire-only — its lifecycle is captured by the `approval_requests` table.

Released as a patch since the SDK is still in 0.x.

---

## 0.6.6 — 2026-05-09

### Outbound `agent_start` event

Added `agent_start` to `OutboundEvent` so SDK consumers see an explicit turn-start signal that mirrors the `agent_start` log entry already written to the message store. Carries `correlationId` (the inbound user-message id, same as the rest of the turn's events). Additive — non-breaking.

---

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
