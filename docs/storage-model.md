# Storage Model

OpenHermit stores durable internal state in PostgreSQL through Drizzle. The schema lives in [../packages/store/src/schema.ts](../packages/store/src/schema.ts), and SQL migrations live in [../packages/store/drizzle/](../packages/store/drizzle/).

## Database Scope

Most tables include `agent_id` and are queried through a `StoreScope`. This gives every agent an isolated state view while sharing one PostgreSQL database.

Global tables:

- `meta`
- `users`
- `user_identities`
- `skills`
- `mcp_servers`

(`meta` is the Drizzle migrations bookkeeping table; the rest are owned data.)

Agent-scoped tables:

- `agents`
- `sessions`
- `session_events`
- `memories`
- `sandboxes`
- `instructions`
- `user_agents`
- `agent_skills`
- `agent_mcp_servers`
- `agent_channels`
- `agent_channel_credentials`
- `agent_secrets`
- `schedules`
- `schedule_runs`

## Tables

| Table | Purpose |
|-------|---------|
| `agents` | Registered agents — runtime config (`config_json`), security policy (`security_json`), workspace directory |
| `sessions` | Durable session index: source, metadata, status, participants, descriptions, working memory |
| `session_events` | Full persisted event log for messages, tool calls/results, errors, and introspection |
| `memories` | Long-term memories keyed by `memory_key` |
| `sandboxes` | Per-agent execution environments (host / docker / e2b / daytona) with lifecycle (`pending` → `provisioned` → `deleted`), `external_id`, and backend-private `runtime_state`. See [`sandbox-model.md`](./sandbox-model.md). |
| `instructions` | Prompt instructions by key, scoped to a single agent. Each new agent is seeded with `identity`, `soul`, `rules`. Owners edit their own; admin "append" fans out to every agent's row. |
| `users` | User records and merge links |
| `user_agents` | User role per agent |
| `user_identities` | Channel identity to user mapping |
| `skills` | Registered skill metadata and host paths |
| `agent_skills` | Global (`*`) and per-agent skill assignments |
| `mcp_servers` | Registered external MCP HTTP servers |
| `agent_mcp_servers` | Global (`*`) and per-agent MCP assignments |
| `agent_channels` | Built-in and external channel rows with encrypted bearer tokens |
| `agent_channel_credentials` | Encrypted channel-owned auth state such as WhatsApp Web / Baileys credentials |
| `agent_secrets` | Per-agent provider/integration secrets, encrypted with `OPENHERMIT_SECRETS_KEY` |
| `schedules` | Cron and one-shot schedule definitions |
| `schedule_runs` | Schedule execution history |
| `research_runs` | Deep Research runs: plan (versioned), source policy, budgets/usage, working state, final `report_json`. Partial unique indexes enforce one nonterminal run per session and idempotent creation by `client_request_id`. |
| `research_steps` | Durable, idempotent workflow steps (unique `(run_id, dedupe_key)`); the execution cursor and audit timeline |
| `research_sources` | Normalized source candidates and acquired snapshots; unique canonical-URL hash per run, content hash for mirror detection |
| `research_evidence` | Verified evidence excerpts with locators; unique `(run_id, evidence_hash)` makes inserts idempotent |

Research data is session-bound: session deletion removes evidence → sources →
steps → runs transactionally before the session rows. Source snapshots
(`snapshot_text`) never leave the server; API responses expose metadata and
evidence excerpts only.

## Wildcard assignments (`agent_id = '*'`)

Some assignment tables support a wildcard agent identifier `'*'` that means
"every agent." A wildcard assignment is a single row stored once; it is
matched at query time, not fanned out at write time:

```sql
WHERE agent_id IN ($agentId, '*')
```

This means:

- One write affects every agent, including agents created later.
- Removing the wildcard removes it for all agents in one operation.
- There are no per-agent rows to keep in sync.

| Table | Wildcard supported | Runtime sync on change |
|-------|--------------------|------------------------|
| `agent_skills` | ✅ | gateway calls `syncAffectedAgentSkillMounts` |
| `agent_mcp_servers` | ✅ | gateway calls `runner.reloadMcpServers()` |
| `schedules` | ❌ — each schedule is owned by exactly one agent | n/a |
| `agent_channels` | ❌ — adapters bind to a specific bot identity | n/a |
| `instructions` | ❌ — owners edit their own per-agent rows. Org-wide changes use the admin `--all` fan-out (`set` / `append` / `remove`), which writes one row per agent. | n/a |

The admin UI, REST API, and CLI all accept `*` in the `agentId` field to
write or remove a wildcard assignment. Example:

```bash
hermit skills enable my-skill --all
hermit mcp enable my-mcp-server --all
```

When designing a new assignment table, prefer the wildcard pattern unless
the resource semantically requires per-agent identity (channels) or
per-agent ownership (schedules).

## Memory Search

`memories.content_tsv` is a generated PostgreSQL `tsvector` column created by migration SQL or lazily by `DbMemoryProvider.ensureFts()`. Search uses:

1. `plainto_tsquery('english', query)` ranked with `ts_rank`
2. per-word `ILIKE` fallback across memory keys and content for partial matches and non-English/CJK content

## Agent config & security policy

The canonical source for an agent's runtime config and security policy
is the `agents` table:

| Column | Replaces |
|--------|----------|
| `agents.config_json` | the legacy per-agent `config.json` file |
| `agents.security_json` | the legacy per-agent `security.json` file |

All reads and writes go through the `AgentConfigStore` interface
(`packages/store`), implemented by `DbAgentConfigStore`. The
gateway's `POST /agents` flow seeds these columns with the default
template; `PUT /api/agents/:id/config` and `PUT /api/agents/:id/secrets`
also write through the stores.

## Per-Agent Secrets And Channel Credentials

Secrets are stored in the `agent_secrets` table, encrypted at rest with
`OPENHERMIT_SECRETS_KEY` (AES-GCM). The `DbSecretStore` is the default
implementation of the `SecretStore` interface. If no key is configured
the gateway logs a warning and falls back to `FileSecretStore`, which
writes a plaintext `secrets.json` under each agent's data dir — this
fallback is for local development only; `hermit setup` provisions the
key and enables the encrypted store.

Secrets are accessed exclusively through `SecretStore`. Config
interpolation (`${{SECRET_NAME}}`), channel-token resolution, and the
admin/owner APIs all go through the same interface — values are never
returned to clients in plaintext after they are written.

Channel-owned auth state that is too large or mutable for `agent_channels.config`
lives in `agent_channel_credentials`, also encrypted with
`OPENHERMIT_SECRETS_KEY`. Channel plugins receive a scoped credential store for
the current `(agent_id, channel_type)` and address only profiles and keys.
WhatsApp uses this for Baileys `creds` and signal key material.

## Per-Agent Files

Per-agent state lives in PostgreSQL. The only on-disk per-agent
artifact is the workspace at `~/.openhermit/workspaces/{agentId}/`,
which holds external task state.

Enabled skills are not stored under a gateway-side per-agent dir —
each `ExecBackend` syncs them into its own sandbox at
`<agent_home>/.openhermit/skills/system/` via `runner.syncSkills`
(docker bind-mounts the workspace skill dir; host writes to
`$HOME/.openhermit/skills/system/`; e2b/daytona upload via SDK).

In file-fallback dev mode (no `OPENHERMIT_SECRETS_KEY`), a per-agent
`secrets.json` may appear under `~/.openhermit/agents/{agentId}/`;
otherwise that directory is unused.

## Migrations

`hermit setup` applies the consolidated Drizzle SQL migration when `DATABASE_URL` is configured and the repo migration directory is available. Development can inspect the database with:

```bash
npm run dev:studio
```

Tests use `DATABASE_URL_TEST` through the root `npm test` script.
