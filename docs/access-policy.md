# Access Policy

> **Status: Phase 0–3 implemented.** Effect model, approval flow, and simplified tool policy are live. Circles (Phase 4) not yet built.

OpenHermit gates all caller-visible resources through a unified access-policy model. Every tool call, file operation, exec command, and MCP tool invocation passes through a single `evaluateAccess` decision point.

## Goals

- One central `evaluateAccess(principal, matches)` decision point. No scattered `if role === ...` checks.
- Same shape for every resource type: a resource carries policy rows with effects and grants.
- Per-agent configurable, with sensible defaults.
- Extensible to new resource types without touching call sites.
- Extensible to new principal kinds (specific user today; groups later) without rewriting call sites.

## Non-goals

- Per-conversation sandbox isolation. The sandbox is the agent's "computer" and is shared across callers.
- Secret-level ACL. Secrets are not injected into the sandbox today; gating happens at the tool layer.
- Output-side redaction. Handled at the input layer (memory / file visibility) instead.
- Quota and rate limiting. Tracked separately from access policy.

## Core abstraction

```ts
interface Principal {
  userId?: string;
  role?: 'owner' | 'user' | 'guest';
  agentId: string;
}

type Grant =
  | { type: 'any' }
  | { type: 'role'; value: 'owner' | 'user' | 'guest' }
  | { type: 'user'; value: string };

type PolicyEffect = 'allow' | 'deny' | 'require_approval';
type AccessDecision = 'allow' | 'deny' | 'require_approval';
```

### PolicyRow

```ts
interface PolicyRow {
  agentId: string;
  resourceType: string;   // tool | file | exec | mcp
  resourceKey: string;
  effect: PolicyEffect;
  grants: Grant[];
  scope: Record<string, unknown>;
}
```

### evaluateAccess

```ts
evaluateAccess(principal, matches, defaultDecision = 'allow'): AccessDecision
```

Evaluation order (deny wins):

1. If `matches` is empty → return `defaultDecision`.
2. For each match where the principal satisfies the grants:
   - If `effect === 'deny'` → return `'deny'` immediately.
   - Track whether any `'require_approval'` or `'allow'` matched.
3. If any `require_approval` matched → `'require_approval'`.
4. If any `allow` matched → `'allow'`.
5. No grant matched the principal → `'deny'`.

Step 5 is critical: when policy rows exist for a resource but none apply to the calling principal, access is denied. This prevents guests from bypassing owner-only tools through grant mismatch.

## Resource types

### Tools

Each tool declares a `ToolPolicy`:

```ts
interface ToolPolicy {
  defaultGrants: Grant[];
}
```

Resolution: DB policy rows for `(agentId, 'tool', toolName)` take precedence. If no DB rows exist, the tool's `defaultGrants` are used as an `allow` effect. If neither exists, access is open (`[{ type: 'any' }]`).

All tools are overridable via DB policy rows. There is no "fixed" vs "configurable" distinction — every tool's default can be widened or narrowed per-agent.

#### Default grants by tool

| Tool | Default grants |
|------|---------------|
| `exec` | owner only |
| `file_read`, `file_list`, `file_stat` | owner + user |
| `file_write`, `file_edit`, `file_delete` | owner only |
| `memory_add`, `memory_update`, `memory_delete` | owner + user |
| `memory_get`, `memory_list`, `memory_recall` | any |
| `schedule_create`, `schedule_update`, `schedule_delete`, `schedule_trigger` | owner only |
| `schedule_list`, `schedule_runs` | any |
| `policy_list`, `policy_set`, `policy_delete` | owner only |
| `identity_link_request`, `identity_link_confirm` | any |
| `user_list`, `user_role_set`, `user_merge`, `user_identity_link`, `user_identity_unlink` | owner only |
| `mcp_enable`, `mcp_disable`, `mcp_status` | owner only |
| `session_list`, `session_read`, `session_summary`, `session_send` | owner + user |
| `web_search`, `web_fetch` | any |
| `instruction_update` | owner only |
| `working_memory_update`, `session_description_update` | system-only (empty grants) |

When a tool's `evaluateAccess` returns `deny` for a principal, the tool is excluded from the tool list for that turn — the agent never sees it.

### Files

File policies use `scope` for structured matching:

```ts
scope: {
  sandbox: string;   // sandbox alias or '*' for any
  mode: string;      // 'read' | 'write' | '*'
  path: string;      // prefix match (e.g. '/workspace/public/')
}
```

`resourceKey` is derived from `scope.path`. Resolution finds the longest prefix match per effect, scoped to the requested mode and sandbox.

When no file-level policy rows exist, access falls back to the tool-level policy for `file_read` / `file_write` etc.

### Exec commands

Exec policies use `scope` for structured matching:

```ts
scope: {
  sandbox: string;   // sandbox alias or '*'
  command: string;    // exact normalized command or '*'
  cwd?: string;      // optional working directory prefix
}
```

Commands are normalized (trim, collapse whitespace) before comparison. `*` matches any command. Specificity: exact command > wildcard; cwd-scoped > unscoped.

When no exec-level policy rows exist, access falls back to the tool-level policy for `exec`.

### MCP tools

MCP tools follow the `mcp__serverId__toolName` naming convention. Policy rows can target:
- Individual MCP tools via `resourceType: 'tool'`, `resourceKey: 'mcp__weather__getTemp'`
- All tools from a server via wildcard: `resourceKey: 'mcp__weather__*'`
- Server-level policy via `resourceType: 'mcp'`, `resourceKey: 'weather'`

### Memory grants

Per-memory visibility during retrieval. Grants on a memory express **who sees it when the agent retrieves context**, not ownership.

Memory grants are single-dimensional (no read/write split). The "write" path is governed by the `memory_add` tool's grants.

```
content="user-abc prefers dark mode"
  grants=[{type:'user', value:'user-abc'}]

content="deploy command for this repo is pnpm deploy:prod"
  grants=[{type:'any'}]

content="last prod deploy failed because of env var X"
  grants=[{type:'role', value:'owner'}]
```

## Approval flow

When `evaluateAccess` returns `require_approval`, the system checks for an existing approved request before prompting.

### ApprovalRequest

```ts
interface ApprovalRequest {
  id: string;
  agentId: string;
  sessionId: string;
  requesterId: string;
  resourceType: string;
  resourceKey: string;
  scope: Record<string, unknown>;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  resolution?: 'once' | 'persistent';
  resolvedBy?: string;
  createdAt: string;
  resolvedAt?: string;
  ttlMinutes: number;    // default: 60
}
```

### Two approval modes

**Real-time approval** — when the owner is in an interactive session (web UI, CLI):

1. `checkApprovalOrRequest` detects `approvalCallback` is available.
2. An `ApprovalRequest` is created (for audit).
3. `approval_requested` (mode=`realtime`) is emitted on the wire and persisted to `session_events`.
4. The UI shows an inline approve/reject prompt (ApprovalGate component).
5. The owner decides; the request is resolved.
6. `approval_resolved` (mode=`realtime`, with `decision` + `resolution`) is emitted and persisted.

**Async approval** — when the requester is on a non-owner channel (e.g. guest on Telegram):

1. No `approvalCallback` available (owner isn't in the session).
2. An `ApprovalRequest` is created with status `pending`.
3. `approval_requested` (mode=`async`) is emitted to the requester's session and persisted.
4. The owner is notified via their configured channel: an `approval_pending` (mode=`async`) wire event is emitted to the owner's session **and** a channel message with an `approval_review` action button is sent. `approval_pending` is wire-only — it is not persisted (the request lifecycle lives in `approval_requests`).
5. `ApprovalRequiredError` is thrown — the agent tells the user to wait and **stops** (does not attempt workarounds).
6. When the owner runs `approval_review`, the request is resolved. `approval_resolved` (mode=`async`) is emitted to the **requester's** session and persisted there, so the requester's UI can clear the pending state. The user can retry.

### Resolution types

- `once` — approval valid for `ttlMinutes` (default 60). Same requester + resource combination is auto-approved within the window.
- `persistent` — approval creates a permanent `effect: 'allow'` policy row for the requester on the target resource. No future approval needed.

### Channel identity for approval reviews

Channel-authenticated API calls (e.g. Telegram bridge) pass the acting user's identity via the `x-channel-user-id` HTTP header. This allows the gateway to resolve the channel user to an owner for authorization when reviewing approval requests.

## Database schema

### agent_policies

```sql
CREATE TABLE agent_policies (
  agent_id      TEXT NOT NULL REFERENCES agents(id),
  resource_type TEXT NOT NULL,          -- tool | file | exec | mcp
  resource_key  TEXT NOT NULL,
  effect        TEXT NOT NULL DEFAULT 'allow',  -- allow | deny | require_approval
  grants        JSONB NOT NULL DEFAULT '[]',
  scope         JSONB NOT NULL DEFAULT '{}',
  PRIMARY KEY (agent_id, resource_type, resource_key, effect)
);
```

### approval_requests

```sql
CREATE TABLE approval_requests (
  id            TEXT PRIMARY KEY,
  agent_id      TEXT NOT NULL REFERENCES agents(id),
  session_id    TEXT NOT NULL,
  requester_id  TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_key  TEXT NOT NULL,
  scope         JSONB NOT NULL DEFAULT '{}',
  status        TEXT NOT NULL DEFAULT 'pending',  -- pending | approved | rejected | expired
  resolution    TEXT,                              -- once | persistent
  resolved_by   TEXT,
  reason        TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at   TIMESTAMPTZ,
  ttl_minutes   INTEGER NOT NULL DEFAULT 60
);

CREATE INDEX idx_approval_requests_agent ON approval_requests (agent_id, status);
```

## Policy management

### Tools

Three owner-only tools manage the `agent_policies` table:

```
policy_list(resourceType?: string)
policy_set(resourceKey, resourceType, effect, grants, scope?)
policy_delete(resourceKey, resourceType?)
```

### API

```
GET    /api/agents/:agentId/policies
POST   /api/agents/:agentId/policies
DELETE /api/agents/:agentId/policies/:resourceType/:resourceKey
```

### Approval endpoints

```
GET    /api/agents/:agentId/approvals
GET    /api/agents/:agentId/approvals/:id
POST   /api/agents/:agentId/approvals/:id/review
```

### Web admin UI

The Policies tab supports:
- Preset grant levels: Everyone, Owner only, Owner+User, Custom JSON
- Effect selection: allow, deny, require_approval
- Structured scope input for file policies (path + mode)
- Resource type selection: tool, file, exec, mcp

### Scope auto-population

When creating policies via API, scope is auto-populated from `resourceKey` if not fully specified:
- File: `{ sandbox: '*', mode: '*', path: resourceKey }`
- Exec: `{ sandbox: '*', command: resourceKey }`

## Sessions

Sessions don't use `agent_policies`. The rule is fixed:

- `owner` — sees all sessions on the agent.
- Everyone else — sees sessions they participated in (resolved through `merge_target` so merged users see history from both pre-merge identities).

## Skills

Skills are managed via the filesystem (install/remove skill files). Not gated through the policy layer.

## Roles

Three levels:

- `owner` — full management and tool access.
- `user` — authenticated, standard interaction. Access to read tools and memory.
- `guest` — anonymous or low-trust. Restricted to read-only file access, web tools, and identity linking by default.

## Design decisions

**Grants are necessary, not sufficient.** A grant decides whether a principal is eligible to attempt an operation. It does not certify the operation is safe to execute. Sensitive tools layer their own verification on top (e.g. `identity_link` uses a two-step token + channel-proof flow regardless of role).

**Approval deduplication.** If the same user requests the same resource while a previous request is pending, a new request is created. The owner reviews each independently. Deduplication was considered but adds complexity without clear benefit at current scale.

**Expiration.** Approved requests with `resolution: 'once'` expire after `ttlMinutes`. Expiration is checked lazily on read (no background job). Expired requests are treated as non-existent — the user must re-trigger approval.

**Notification routing.** Approval notifications are sent to the owner via their configured channel outbound adapters (Telegram, Slack, etc.), not via a fixed session ID. The channel adapter renders approve/reject buttons appropriate to its platform.

## Deprecated fields

The following SecurityPolicy fields are deprecated in favor of policy rows:

| Deprecated field | Replacement |
|-----------------|-------------|
| `autonomy_level: 'readonly'` | `effect: 'deny'` rows on write tools |
| `autonomy_level: 'supervised'` + `require_approval_for` | `effect: 'require_approval'` rows on specific tools |
| `autonomy_level: 'full'` | No deny/require_approval rows (default state) |

These fields still work as syntactic sugar — on load, they are synthesized into virtual policy rows (not persisted to DB). Real DB rows take precedence.

## Phased rollout

- **Phase 1 — central policy foundation.** ✅ `agent_policies` table, central `evaluateAccess`, removed `GUEST_BLOCKED_TOOLS` and `DEFAULT_TOOL_GRANTS`.
- **Phase 2 — admin surface.** ✅ `policy_list/set/delete` owner tools, API endpoints, SDK, CLI, web admin UI with Policies tab.
- **Phase 2.5 — per-memory grants.** ✅ `grants` column on `memories` table, memory read tools filter by principal, `memory_add` accepts grants, `memory_set_grants` owner tool.
- **Phase 3 — effect model + approval flow.** ✅ Three-effect policy rows, `evaluateAccess`, ApprovalRequest storage, real-time + async approval, simplified ToolPolicy, channel identity forwarding.
- **Phase 4 — circles.** 🔲 Owner-defined user groups for batched authorization. See design below.

## Future: circles

Per-user grants are precise but tedious once an owner has more than a handful of people to authorise individually. The `Grant` type is designed to extend with a `circle` variant:

```ts
type Grant =
  | { type: 'any' }
  | { type: 'role';   value: 'owner'|'user'|'guest' }
  | { type: 'user';   value: string }
  | { type: 'circle'; value: string };   // 'family' | 'colleagues' | 'beta-testers' | ...
```

Roles are a fixed trust hierarchy (owner > user > guest) used by system-level fallbacks. Circles are flat, owner-defined labels with no internal ordering. A user may belong to multiple circles; matching is OR.

Slated for after the per-user grant mechanism shows real demand for batched authorization.
