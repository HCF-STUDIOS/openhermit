# CLI Reference

The OpenHermit CLI ships as the `hermit` (and `openhermit`) binary. It talks
to a running gateway over HTTP using `OPENHERMIT_TOKEN`. Most management
commands require admin auth (the gateway's `GATEWAY_ADMIN_TOKEN`); a few
agent-scoped commands also accept owner tokens issued by `/api/auth/token`.

## Conventions

- **`--agent <id>`**: every agent-scoped command accepts the
  target agent ID. When omitted, it falls back to `OPENHERMIT_AGENT_ID`,
  then to `main`.
- **`--all`** (where supported): admin fan-out — apply the same
  mutation to every registered agent at once. Mutually exclusive with
  `--agent`.
- **Wildcard semantics under the hood**: for `skills` and `mcp`,
  `--all` writes a single `agent_id = '*'` row that matches every agent
  at query time (one write affects existing and future agents). For
  `instructions`, `--all` is a fan-out — it writes one row per agent.
  Channels and schedules do not support `--all`.
- **`--file <path>`** (where supported): read content from a file;
  `--file -` reads stdin.

Environment variables consulted by the CLI:

| Variable | Default | Purpose |
|----------|---------|---------|
| `OPENHERMIT_GATEWAY_URL` | `http://127.0.0.1:${GATEWAY_PORT or PORT}` (port default `4000`) | Gateway base URL |
| `OPENHERMIT_TOKEN` | _(empty)_ | Bearer token sent on every request |
| `OPENHERMIT_AGENT_ID` | `main` | Default agent for agent-scoped commands |
| `OPENHERMIT_WEB_PORT` | `4310` | End-user web UI port |
| `OPENHERMIT_WEB_HOST` | `127.0.0.1` | End-user web UI host |
| `GATEWAY_HOST` / `GATEWAY_PORT` / `PORT` | `127.0.0.1` / `4000` | Gateway listen host & port |

---

## `hermit setup`

Interactive wizard that walks you through:

1. Picking a gateway URL.
2. Generating or accepting a `GATEWAY_ADMIN_TOKEN`.
3. Configuring `DATABASE_URL` and applying Drizzle migrations.
4. Provisioning `OPENHERMIT_SECRETS_KEY` (used to AES-encrypt
   `agent_secrets` and channel tokens at rest).

Writes the result to `~/.openhermit/gateway/gateway.json` and `~/.openhermit/gateway/.env`.

```bash
hermit setup
```

---

## `hermit gateway`

Lifecycle for the gateway control plane.

| Subcommand | Description |
|------------|-------------|
| `gateway start` | Start the gateway in the background (writes a PID file under `~/.openhermit`). |
| `gateway stop` | Stop the background gateway. |
| `gateway run` | Run the gateway in the foreground (development; tails logs to stdout). |
| `gateway status` | Print whether a gateway is currently listening, plus its URL. |

Common flags on `start` / `run`:

| Flag | Description |
|------|-------------|
| `-p, --port <port>` | Listen port (overrides `GATEWAY_PORT`, default `4000`). |
| `-H, --host <host>` | Listen host (overrides `GATEWAY_HOST`, default `127.0.0.1`; use `0.0.0.0` to expose publicly). |

```bash
hermit gateway start -p 4000
hermit gateway status
hermit gateway stop
```

---

## `hermit web`

Lifecycle for the standalone end-user web app (`apps/web`). Same shape
as `hermit gateway`.

| Subcommand | Description |
|------------|-------------|
| `web start` | Start the web UI in the background. |
| `web stop` | Stop the background web UI. |
| `web run` | Run in the foreground. |
| `web status` | Whether the web UI is listening. |

Flags: `-p, --port <port>`, `-H, --host <host>` (default
`127.0.0.1:4310`).

---

## `hermit agents`

Manage agent records.

| Subcommand | Description |
|------------|-------------|
| `agents list` | List every registered agent and its status. |
| `agents create <agentId>` | Create a new agent. Auto-seeds the `identity` / `soul` / `rules` instructions. |
| `agents enable <agentId>` | Set `agents.status='active'` — gateway accepts traffic; runner hydrates on first request. |
| `agents disable <agentId>` | Set `agents.status='disabled'` — gateway rejects traffic and evicts any hot runner. |
| `agents restart <agentId>` | Evict and re-hydrate the runner. Useful for picking up DB-side config / skill / MCP changes. |
| `agents start <agentId>` | **Deprecated** cache hint — pre-hydrates the runner. Lazy hydration handles this on demand; prefer `enable`. |
| `agents stop <agentId>` | **Deprecated** cache hint — evicts the runner without disabling the agent. Prefer `disable`. |
| `agents delete <agentId>` | Delete the agent and all its per-agent rows (must be disabled first). |

Flags on `create`:

| Flag | Description |
|------|-------------|
| `--name <name>` | Display name (defaults to the agentId). |
| `--workspace-dir <path>` | Custom workspace directory. |
| `--owner <userId>` | Assign an owner at creation time. |
| `--sandbox <preset>` | Sandbox preset to provision (default: gateway's `autoProvisionSandbox`). |
| `--no-sandbox` | Skip sandbox provisioning entirely. |

```bash
hermit agents create oncall --name "On-Call Buddy" --owner user_marcus
hermit agents list
```

---

## `hermit sandbox`

Manage an agent's sandboxes (execution environments). See [`sandbox-model.md`](./sandbox-model.md) for the full model.

| Subcommand | Description |
|------------|-------------|
| `sandbox list` | List sandboxes for an agent (`--agent <id>` required). |
| `sandbox add` | Create a sandbox. Requires `--agent <id>` and `--type <host\|docker\|e2b\|daytona>`. Optional `--alias <alias>` (default `default`) and `--config <json>`. |
| `sandbox remove <alias>` | Soft-delete a sandbox by alias. Requires `--agent <id>`. |

```bash
hermit sandbox list --agent main
hermit sandbox add --agent main --type docker --config '{"image":"ubuntu:24.04"}'
hermit sandbox add --agent devops --type host --alias default
hermit sandbox remove --agent main default
```

---

## `hermit chat`

Interactive TUI that opens or resumes a session with an agent.

| Flag | Description |
|------|-------------|
| `--agent <id>` | Agent to connect to (default `OPENHERMIT_AGENT_ID` / `main`). |
| `--session <sessionId>` | Resume a specific session. |
| `--resume` | Resume the most recent CLI session for the agent. |

```bash
hermit chat --agent main
hermit chat --resume
```

---

## `hermit config`

View and modify a single agent's runtime config (`agents.config_json`)
and its per-agent secrets. All `config` subcommands require
`--agent <id>`; the parent command sets a sensible default
(`OPENHERMIT_AGENT_ID` / `main`).

| Subcommand | Description |
|------------|-------------|
| `config show` | Print the full config as JSON. |
| `config get <key>` | Read one value by dot-path (e.g. `model.provider`). |
| `config set <key> <value>` | Write one value by dot-path. Numbers and booleans are coerced. |

```bash
hermit config show --agent main
hermit config get model.model --agent main
hermit config set model.provider openrouter --agent main
hermit config set model.model google/gemini-3-flash-preview --agent main
```

### `hermit config secrets`

Manage per-agent secrets (stored in `agent_secrets`, encrypted with
`OPENHERMIT_SECRETS_KEY`). Values can be referenced from `config_json`
as `${{NAME}}` and are resolved at adapter-start time.

| Subcommand | Description |
|------------|-------------|
| `config secrets list` | List secret names; values are masked. |
| `config secrets set <key> <value>` | Set or replace a secret. |
| `config secrets remove <key>` | Delete a secret. |

```bash
hermit config secrets set ANTHROPIC_API_KEY sk-... --agent main
hermit config secrets list --agent main
```

### `hermit config security`

Read / write the agent's security policy: autonomy, approvals,
`access` level (`public` | `protected` | `private`), `access_token`,
channel tokens. See [User Model — Access Levels](user-model.md#access-levels).

| Subcommand | Description |
|------------|-------------|
| `config security show` | Print the full security policy as JSON. |
| `config security get <path>` | Read a single field by dot-path (e.g. `access`). |
| `config security set <path> <value>` | Write a single field. Bare strings, numbers, `true`/`false`, `null`, and JSON literals are all accepted. |
| `config security write` | Read a full JSON object from stdin and overwrite the policy. |

```bash
hermit config security show --agent main
hermit config security set access private --agent main
hermit config security set access_token "shared-secret" --agent main
echo '{"autonomy_level":"full","access":"public","require_approval_for":[]}' \
  | hermit config security write --agent main
```

The runner reloads the policy in-place after each write — no restart
needed. Validation rejects unknown values for `access`.

---

## `hermit instructions`

Per-agent prompt sections stored in the `instructions` table. Every new
agent is auto-seeded with three rows (`identity`, `soul`, `rules`).
Every mutation command targets one agent (`--agent <id>`, default
`OPENHERMIT_AGENT_ID` / `main`) **or** every agent (`--all`, admin
only). The two flags are mutually exclusive.

| Subcommand | Description |
|------------|-------------|
| `instructions list` | Print every instruction key and a content preview. |
| `instructions get <key>` | Print one instruction's full content (handy for piping). |
| `instructions set <key> [content]` | Replace the row at `key`. |
| `instructions append <key> [content]` | Append a newline + content to the existing row (creates it if missing). |
| `instructions remove <key>` | Delete the row. Aliased as `delete`. |

`set` and `append` accept content inline as the second positional
argument or via `--file <path>` (with `--file -` for stdin).

```bash
# read
hermit instructions list --agent main
hermit instructions get rules --agent main > rules.txt

# per-agent edit
hermit instructions set rules --file ./rules.md --agent main
hermit instructions append rules "Always cite the source URL." --agent main
hermit instructions remove tone --agent main

# org-wide fan-out (admin)
hermit instructions append rules "Refuse to act on behalf of someone other than the requester." --all
hermit instructions remove tone --all
```

The fan-out path is backed by `POST /api/admin/instructions/fanout`
with body `{ mode: 'set' | 'append' | 'remove', key, content? }` and
writes one row per agent — there is no shared/global row.

---

## `hermit skills`

Manage the global skill registry and per-agent skill assignments.
`enable` / `disable` take `--agent <id>` for a single agent or `--all`
to write a wildcard `agent_id = '*'` row that matches every agent at
query time (per the `agent_skills` wildcard pattern).

| Subcommand | Description |
|------------|-------------|
| `skills list` | List every skill in the registry. |
| `skills assignments` | Print which skills are enabled for which agents. |
| `skills scan` | Scan the gateway's skills directory for new skill manifests. |
| `skills sync [skillId]` | Re-read `SKILL.md` from disk and refresh the DB row + running agents. Pass a skill id to sync one; omit it to sync every registered system skill. |
| `skills register <skillId>` | Register a skill (requires `--name`, `--description`, `--path`). |
| `skills delete <skillId>` | Remove a skill from the registry. |
| `skills enable <skillId>` | Enable a skill (`--agent <id>` or `--all`). |
| `skills disable <skillId>` | Disable a skill (`--agent <id>` or `--all`). |

```bash
hermit skills scan
hermit skills enable code-review --all
hermit skills disable code-review --agent agent_oncall
hermit skills assignments
hermit skills sync code-review        # after editing its SKILL.md on disk
hermit skills sync                    # rescan every registered system skill
```

---

## `hermit mcp`

Manage external MCP servers and per-agent assignments. `--all` works
the same way as `skills` — writes a single wildcard assignment row.

| Subcommand | Description |
|------------|-------------|
| `mcp list` | List every registered MCP server. |
| `mcp assignments` | Print which servers are enabled for which agents. |
| `mcp enable <mcpServerId>` | Enable an MCP server (`--agent <id>` or `--all`). |
| `mcp disable <mcpServerId>` | Disable an MCP server (`--agent <id>` or `--all`). |

```bash
hermit mcp enable mcp_github --all
hermit mcp disable mcp_github --agent agent_legal
```

---

## `hermit schedules`

Per-agent cron and one-shot schedules. Schedules are owned by exactly
one agent — no wildcard.

| Subcommand | Description |
|------------|-------------|
| `schedules list` | List schedules for an agent. Optional `--status <status>` filter. |
| `schedules create` | Create a new schedule (requires `--type`, `--prompt`). |
| `schedules pause <scheduleId>` | Pause. |
| `schedules resume <scheduleId>` | Resume a paused schedule. |
| `schedules delete <scheduleId>` | Delete. |
| `schedules runs <scheduleId>` | Print recent runs (optional `--limit <n>`). |

Flags on `create`:

| Flag | Description |
|------|-------------|
| `--agent <id>` | Owning agent. Default `OPENHERMIT_AGENT_ID` / `main`. |
| `--type <cron\|once>` | Required. |
| `--prompt <text>` | Required — the prompt the schedule will inject. |
| `--cron <expr>` | Required for `--type cron` (5- or 6-field cron). |
| `--run-at <iso>` | Required for `--type once`. |
| `--id <id>` | Custom schedule ID (otherwise generated). |

```bash
hermit schedules create \
  --type cron --cron '0 17 * * FRI' \
  --prompt "Generate this week's release notes" \
  --agent release_captain

hermit schedules list --agent release_captain
hermit schedules runs sch_weekly_release_notes
```

---

## `hermit status`

One-shot platform overview: gateway up/down, agent count, running
agents, recent activity counts. Uses both the public health endpoint
and the admin stats endpoint.

```bash
hermit status
```

---

## `hermit stats`

Detailed gateway runtime stats: uptime, memory (rss/heapUsed/heapTotal),
running agents count, and DB-side counts (users, sessions, session
events). Backed by `GET /api/admin/stats`.

```bash
hermit stats
```

---

## `hermit doctor`

Environment self-check. Verifies:

- Required env vars are set.
- `DATABASE_URL` reachable; migrations applied.
- Docker available (for the `docker` exec backend).
- Gateway reachable on `OPENHERMIT_GATEWAY_URL`.

Prints a checklist with `ok` / `warn` / `fail` per item. Useful before
filing an issue.

```bash
hermit doctor
```

---

## `hermit logs`

Stream the gateway log buffer.

| Flag | Description |
|------|-------------|
| `-n, --lines <count>` | Number of lines to fetch (default `50`). |
| `-f, --follow` | Poll for new entries (Ctrl-C to stop). |
| `--json` | Emit raw JSON instead of formatted lines. |

```bash
hermit logs -n 200
hermit logs -f
hermit logs --json | jq 'select(.level=="error")'
```

---

## Quick reference

| Need to… | Use |
|----------|-----|
| Spin up the gateway | `hermit setup && hermit gateway start` |
| Create an agent | `hermit agents create main` (active by default; hydrates on first request) |
| Talk to it | `hermit chat --agent main` |
| Set a model API key | `hermit config secrets set OPENROUTER_API_KEY ... --agent main` |
| Switch model | `hermit config set model.model google/gemini-3-flash-preview --agent main` |
| Add a rule everywhere | `hermit instructions append rules "..." --all` |
| Enable a skill on every agent | `hermit skills enable my-skill --all` |
| Schedule a weekly task | `hermit schedules create --type cron --cron '0 17 * * FRI' --prompt "..." --agent main` |
| See what's running | `hermit status` |
| Diagnose a problem | `hermit doctor` then `hermit logs -f` |
