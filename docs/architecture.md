# Architecture

OpenHermit is a gateway-managed, multi-agent runtime. The gateway owns process lifecycle, the API surface, the channel-bridge pool, and the central cron scheduler. Per agent, an in-process `AgentRunner` carries the workspace, security policy, tools, MCP connections, and per-session state — runners hydrate on demand when traffic arrives and are LRU-evicted when idle (controlled by `OPENHERMIT_EVICTION_TTL_MINUTES`, default 30). `agents.status` ('active' / 'disabled') in the DB is the source of truth for whether traffic is accepted; the in-memory runner map is a hydration cache, not a lifecycle.

## Components

```text
CLI / Web / Channels / API clients
          |
          v
Gateway (Hono HTTP + WebSocket, auth, admin UI)
          |
          v
AgentInstanceManager
          |
          +-- AgentRunner(agent A) -> exec backend -> docker / host / e2b / daytona
          +-- AgentRunner(agent B) -> exec backend -> docker / host / e2b / daytona
          |
          v
PostgreSQL stores (Drizzle)
```

| Component | Responsibility |
|-----------|----------------|
| `apps/gateway` | Control plane, auth, admin API, admin UI, agent lifecycle, WebSocket attachment, channel startup |
| `apps/agent` | Agent loop, prompt assembly, tools, sessions, events, introspection, compaction, MCP client manager |
| `apps/cli` | Setup, gateway lifecycle, agent management, chat TUI, config/secrets, schedules, logs/status |
| `apps/web` | Standalone end-user chat web app |
| `apps/channels/*` | Telegram, Discord, and Slack bridges |
| `packages/protocol` | Shared contracts and route builders |
| `packages/sdk` | HTTP/SSE/WebSocket clients used by CLI/channels |
| `packages/store` | Drizzle schema and PostgreSQL store implementations |
| `packages/shared` | Errors, env loading, URL helpers, OpenHermit home helpers |

## State Boundary

OpenHermit keeps internal runtime state separate from external task state.

**Internal state** is owned by OpenHermit and stored in PostgreSQL unless noted:

- agent records
- sessions and session events
- working memory and session descriptions
- long-term memories
- instructions
- users, roles, identities, and merges
- sandbox rows (per-agent execution environments) and their runtime state
- skills and skill assignments
- MCP server definitions and assignments
- schedules and schedule runs
- per-agent runtime config and security policy (`agents.config_json` / `agents.security_json` columns)
- per-agent secrets (encrypted in the `agent_secrets` table when `OPENHERMIT_SECRETS_KEY` is set; falls back to per-agent `secrets.json` only when no key is configured)
- channel rows with encrypted tokens (`agent_channels`)

**External state** is the user's work surface:

- workspace files
- generated artifacts
- project repositories
- mounted data under the workspace
- workspace-installed skills under `.openhermit/skills`

## Per-Agent State

Runtime config, security policy, and per-agent secrets are stored in PostgreSQL (`agents.config_json`, `agents.security_json`, `agent_secrets`) and managed through the admin UI, REST API, or `hermit config ... / hermit security ...`. Channels live in `agent_channels` with encrypted tokens, managed through `/api/agents/{agentId}/channels/...`. Secrets are encrypted at rest with `OPENHERMIT_SECRETS_KEY`; if no key is configured the gateway falls back to a plaintext `secrets.json` per agent (local-dev only — `hermit setup` enables the encrypted DB store).

Per-agent state lives in Postgres; the only per-agent artifact on disk is the workspace:

```text
~/.openhermit/
├── gateway/             # gateway.json, .env, registry/, logs
└── workspaces/{agentId}/
```

Enabled skills are synced into each backend's own sandbox at `<agent_home>/.openhermit/skills/system/` rather than living under a gateway-side per-agent dir.

`config_json` controls model, exec backend, web provider, and memory introspection. `security_json` controls autonomy level, approval policy, access level, and access token. Secrets are referenced from config values with `${{SECRET_NAME}}` and resolved through `SecretStore` at adapter-start time.

Per-agent **instructions** (the keyed sections of the system prompt) live in the `instructions` table, scoped by `agent_id` like schedules — there is no shared/global row. Each new agent is auto-seeded with three rows on creation: `identity`, `soul`, and `rules`. Owners edit their own; admins can apply the same mutation across every agent with `--all` (e.g. `hermit instructions append rules "Always cite the source URL." --all`), backed by `POST /api/admin/instructions/fanout` with `{ mode: 'set' | 'append' | 'remove', key, content? }`.

## Gateway Runtime

On startup, the gateway:

1. loads environment variables
2. loads `~/.openhermit/gateway/gateway.json`
3. opens PostgreSQL stores if `DATABASE_URL` is available
4. scans and registers built-in skills from `skills/`
5. starts the Hono server and WebSocket handler
6. boots the channel pool — bridges (Telegram/Slack/Discord) attach to gateway HTTP routes; runners hydrate lazily on first inbound traffic

Agents hydrate on demand: the first request that targets an agent constructs its `AgentRunner`, syncs enabled skills into the sandbox via `runner.syncSkills`, attaches existing channel outbounds from the pool, and connects enabled MCP servers lazily through the runner. Schedules fire from a single gateway-level `CentralScheduler` that hydrates the target runner on demand at fire time. Idle runners are evicted by an LRU after `OPENHERMIT_EVICTION_TTL_MINUTES`; channel bridges in the pool stay alive across eviction.

## Agent Runtime

`AgentRunner` owns:

- durable session open/resume/list/delete behavior
- user and role resolution
- message queueing per session
- prompt assembly from instructions, memory, skills, user context, and recent history
- tool creation and role-based filtering
- tool approval pauses
- event persistence and realtime publication
- context compaction for long sessions
- introspection for memory and session metadata maintenance
- schedule execution host callbacks
- MCP tool discovery and namespacing
- channel outbound adapters for proactive `session_send`

The main model loop is backed by `@mariozechner/pi-agent-core` and `@mariozechner/pi-ai`.

## Execution Backends

The `exec` tool uses `ExecBackendManager`, built from the agent's rows in the `sandboxes` table (see [`sandbox-model.md`](./sandbox-model.md)).

Supported backend types:

- `docker`: per-agent workspace container managed by the gateway
- `host`: runs commands on the gateway host (devops-only — see sandbox-model.md)
- `e2b`: runs commands in a per-agent [E2B](https://e2b.dev) cloud sandbox
- `daytona`: runs commands in a per-agent [Daytona](https://www.daytona.io) cloud sandbox

Agents created through the gateway use the preset named by `autoProvisionSandbox` in `gateway.json` (default: `docker-ubuntu`); pass `sandbox: "<preset>"` or `null` on `POST /api/agents` to override.

Sandbox lifecycle (per backend) supports:

- start: `ondemand` or `session`
- stop: `idle` or `session`
- idle timeout in minutes

## Auth

Admin APIs require `GATEWAY_ADMIN_TOKEN`. Agent routes use a resolver that accepts:

- admin bearer token
- browser/device JWTs issued by `POST /api/auth/token` (user-global; the JWT identifies a person, not an agent)
- channel bearer tokens registered for built-in or external channel adapters

Agent access can be `public`, `protected`, or `private`. `protected` requires the agent access token during device-token exchange (members self-join via `/members`); `private` rejects anyone without an explicit membership row at session-open time. See [`sandbox-model.md`](./sandbox-model.md) for the full policy.

## Extension Surfaces

- **Tools:** built-in toolsets plus dynamically connected MCP tools
- **Skills:** prompt instructions and supporting files, registered in DB and synced into each backend's sandbox via `runner.syncSkills`
- **Channels:** Telegram, Discord, Slack built-ins plus channel-token support for external adapters
- **Schedules:** cron/once jobs that post prompts into dedicated or configured sessions
- **Web providers:** Defuddle, Exa, Tavily

## Development Commands

```bash
npm run dev:gateway
npm run dev:web
npm run dev:cli
npm run dev:studio
npm run typecheck
npm test
```
