# Sandbox Model

A **sandbox** is the execution environment an agent uses to run shell commands and host its workspace files. Each agent has zero or more sandboxes, each persisted as a row in the `sandboxes` table; the runtime constructs an `ExecBackend` from each row when the agent starts.

Four backend types are supported:

- `host` — runs commands directly on the gateway host. No isolation. At most one host sandbox per gateway.
- `docker` — runs commands inside a per-agent Docker container managed by the gateway.
- `e2b` — runs commands inside an [E2B](https://e2b.dev) cloud sandbox.
- `daytona` — runs commands inside a [Daytona](https://www.daytona.io) cloud sandbox.

## Sandbox Row

Each sandbox row carries:

| Field | Description |
|---|---|
| `id` | UUID |
| `agent_id` | Owning agent |
| `alias` | Per-agent unique name. The default alias is `default`. |
| `type` | `host` / `docker` / `e2b` / `daytona` |
| `config` | Type-specific config blob (see below) |
| `status` | Lifecycle state: `pending` → `provisioned` → `deleted` (soft delete) |
| `external_id` | Backend-assigned identifier (container name, e2b sandbox id, etc.) |
| `runtime_state` | Backend-private JSONB used to reconnect after a gateway restart (e.g. queued skill syncs) |
| `last_seen_at` | Last successful `ensure()` |

A row starts at `pending` and flips to `provisioned` the first time the backend's `ensure()` succeeds. The `runtime_state` lets backends like `e2b` and `daytona` reconnect to a long-lived remote sandbox across gateway restarts. Live runtime state (running vs stopped vs paused) is intentionally **not** stored — the backend itself is the source of truth.

`alias` is unique per agent under a partial index that excludes `deleted` rows, so the same alias can be re-created after a soft delete.

## Backend Configs

### `host`

```json
{ "type": "host", "config": {} }
```

All fields optional:

- `cwd` — defaults to the agent's workspace dir
- `shell` — defaults to `sh`
- `env` — extra env vars merged on top of the gateway process environment
- `timeout_ms` — per-command timeout, default 5 min

The host backend treats the gateway machine as the sandbox; only one agent per gateway can hold the host sandbox (enforced at the API layer).

> ⚠️ **Reserved for the devops agent.** The `host` backend gives the agent unsandboxed shell access to the gateway machine itself — every command runs as the gateway process user, on the same filesystem and network as the gateway. It is intended for a single privileged operator agent that manages the host (the "devops" agent) and **must** be paired with `access: "private"` so only the owner / explicitly added admins can talk to it. Do not use `host` for general-purpose agents; pick `docker`, `e2b`, or `daytona` instead.

### `docker`

```json
{
  "type": "docker",
  "config": {
    "image": "ubuntu:24.04",
    "username": "root",
    "agent_home": "/root"
  }
}
```

`username` and `agent_home` default to `root` / `/root` for ubuntu images. The agent's workspace dir is mounted at `agent_home`. `external_id` records the container name. Optional `memory_limit`, `cpu_shares`, and a per-backend `lifecycle` block override the agent-level lifecycle.

### `e2b`

```json
{
  "type": "e2b",
  "config": {
    "template": "base",
    "username": "user",
    "agent_home": "/home/user",
    "sandbox_timeout_ms": 3600000
  }
}
```

Requires `E2B_API_KEY` in the gateway environment. `template` is the E2B template id. `external_id` records the e2b sandbox id; `runtime_state` queues skill-sync operations so they replay deterministically when the sandbox is reconnected after a gateway restart.

### `daytona`

```json
{
  "type": "daytona",
  "config": {
    "image": "ubuntu:24.04",
    "username": "daytona",
    "agent_home": "/home/daytona"
  }
}
```

Requires `DAYTONA_API_KEY`. Pass `snapshot` (snapshot id) or `image` (mutually exclusive). Daytona auto-stops idle sandboxes after `auto_stop_interval_minutes` (Daytona default 15) and auto-archives after 7 days; `ensure()` calls `start()` which transparently recovers archived sandboxes — no explicit recover step is needed.

## Sandbox Presets

Presets live in `gateway.json` and let operators define a small registry of named sandbox templates that users can pick from at agent-create time.

```json
{
  "sandboxPresets": {
    "docker-ubuntu": {
      "type": "docker",
      "config": { "image": "ubuntu:24.04", "username": "root", "agent_home": "/root" }
    },
    "e2b-default":   { "type": "e2b",     "config": { "template": "base" } },
    "daytona-default": { "type": "daytona", "config": {} }
  },
  "autoProvisionSandbox": "docker-ubuntu"
}
```

`autoProvisionSandbox` references a preset by name (or `null` to disable auto-provisioning). It is the default when an agent is created without an explicit `sandbox` field.

`POST /api/agents` accepts a `sandbox` field:

- omitted → use `autoProvisionSandbox`
- string  → use that preset
- `null`  → skip provisioning entirely (the agent has no sandbox until one is added)

The web UI's create-agent dialog renders a dropdown populated from `GET /api/sandbox-presets`.

## Per-Agent Sandbox API

| Method | Path | Notes |
|---|---|---|
| `GET`    | `/api/agents/:id/sandboxes` | List active sandboxes for the agent |
| `POST`   | `/api/agents/:id/sandboxes` | Add a sandbox: `{ type, alias?, config? }`. Defaults `alias: "default"`. |
| `DELETE` | `/api/agents/:id/sandboxes/:alias` | Soft-delete (status flips to `deleted`) |

CLI mirror:

```bash
hermit sandbox list --agent <id>
hermit sandbox add  --agent <id> --type host
hermit sandbox add  --agent <id> --type e2b --config '{"template":"base"}'
hermit sandbox remove --agent <id> default
```

The admin UI's **Sandboxes** tab lists every sandbox across all agents, with the lifecycle column from the DB and a runtime column that overlays live `docker ps` info for docker rows (or `—` when the container isn't on this host).

## Lifecycle (per-backend behavior)

The agent config's `exec.lifecycle` block controls when a backend is brought up and torn down:

```json
{
  "exec": {
    "lifecycle": {
      "start": "ondemand",
      "stop": "idle",
      "idle_timeout_minutes": 5
    }
  }
}
```

Start policy:

- `ondemand` — `ensure()` runs the first time a tool call needs the backend
- `session`  — `ensure()` runs when a session opens

Stop policy:

- `idle`    — `shutdown()` runs after `idle_timeout_minutes` of inactivity
- `session` — `shutdown()` runs when the session ends

Soft-deleting a sandbox row (via DELETE) does **not** automatically tear down the remote resource for `e2b` / `daytona`; clean those up explicitly through the respective provider if you want to reclaim the cloud sandbox immediately.

## Security Policy

The security policy (in the `agents.security_json` column, managed via `PUT /api/agents/:id/security` or `hermit config security`) is a separate concern from the sandbox: the sandbox decides **where** commands run; the security policy decides **who can talk to the agent** and **when commands need approval**.

```json
{
  "access": "private",
  "autonomy_level": "supervised",
  "require_approval_for": ["exec"],
  "access_token": "..."
}
```

`access` ∈ `public` / `protected` / `private`:

- `public`    — any sender can open a session; unknown channel identities auto-claim a `guest` membership
- `protected` — sender must present `access_token` (via `/members` self-join) to become a member
- `private`   — only owner / admin can add members; everyone else gets a 404 on session open

The runtime enforces `access` at session-open time: a sender with no membership row on a non-public agent is rejected before any message is processed, regardless of whether they have a global user record from another agent.
