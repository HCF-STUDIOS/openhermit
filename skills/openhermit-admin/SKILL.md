---
name: openhermit-admin
description: Explain what OpenHermit is and how to deploy and administer it — setup, CLI, gateway, agent config, API. Use when the user asks about installing, operating, or administering an OpenHermit deployment. For how agents behave for their owners/users/guests, see openhermit-guide.
---

# OpenHermit Usage Guide

Use this guide when explaining OpenHermit itself.

## What OpenHermit Is

OpenHermit is a TypeScript multi-agent platform with:

- gateway-managed agents
- PostgreSQL internal state through Drizzle stores
- CLI, admin UI, and end-user web app
- Telegram, Discord, and Slack channel adapters
- cron/once schedules
- prompt-based skills
- MCP server tool integrations
- Docker, host, and E2B exec backends

The gateway manages agent lifecycle, auth, APIs, WebSocket/SSE transport, built-in channels, schedules, skills, and MCP assignments.

## Setup

```bash
npm install -g openhermit
hermit setup
hermit gateway start
hermit agents create main
hermit agents start main
hermit chat --agent main
```

`hermit setup` configures `.env`, can start local PostgreSQL through Docker Compose, applies Drizzle SQL migrations, and writes `OPENHERMIT_TOKEN` from the admin token for CLI use.

## Environment

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection string |
| `DATABASE_URL_TEST` | Test database URL |
| `GATEWAY_ADMIN_TOKEN` | Admin bearer token |
| `GATEWAY_JWT_SECRET` | JWT signing secret |
| `OPENHERMIT_TOKEN` | CLI token, usually the admin token |
| `OPENHERMIT_GATEWAY_URL` | Gateway URL, default `http://127.0.0.1:4000` |
| `OPENHERMIT_AGENT_ID` | Default agent ID, default `main` |
| `OPENHERMIT_WEB_PORT` | End-user web app port, default `4310` |

## CLI

| Area | Commands |
|------|----------|
| Setup | `hermit setup` |
| Gateway | `hermit gateway start`, `stop`, `run`, `status` |
| Agents | `hermit agents list`, `create`, `start`, `stop`, `restart`, `delete` |
| Chat | `hermit chat`, `hermit chat --agent <id>`, `--resume`, `--session <id>` |
| Config | `hermit config show`, `get`, `set` |
| Secrets | `hermit config secrets list`, `set`, `remove` |
| Instructions | `hermit instructions list`, `get`, `set`, `append`, `remove` — single-agent (`--agent <id>`) or admin fan-out (`--all`) |
| Skills | `hermit skills list`, `assignments`, `scan`, `register`, `delete`, `enable`, `disable` |
| MCP | `hermit mcp list`, `assignments`, `enable`, `disable` |
| Schedules | `hermit schedules list`, `create`, `pause`, `resume`, `delete`, `runs` |
| Ops | `hermit status`, `hermit stats`, `hermit doctor`, `hermit logs` |

## Agent Config

Agent config and security policy are stored in PostgreSQL (`agents.config_json` / `agents.security_json`) and managed through the admin UI, REST API, or `hermit config ...` / `hermit security ...`. The shapes below describe the JSON value stored in those columns.

Model:

```json
{
  "model": {
    "provider": "openrouter",
    "model": "google/gemini-3-flash-preview",
    "max_tokens": 8192
  }
}
```

Exec:

```json
{
  "exec": {
    "backends": [
      { "type": "docker", "image": "ubuntu:24.04" },
      { "type": "host", "cwd": "/path/to/project" }
    ],
    "default_backend": "docker",
    "lifecycle": {
      "start": "ondemand",
      "stop": "idle",
      "idle_timeout_minutes": 5
    }
  }
}
```

Channels are not part of `config.json` — they live in the `agent_channels` table with encrypted tokens. Manage them via the admin UI, the `/api/agents/{agentId}/channels/...` routes, or `hermit channels ...`.

Provider/integration secrets are stored per-agent in the `agent_secrets` table, encrypted with `OPENHERMIT_SECRETS_KEY`. Set with `hermit config secrets set KEY value` and reference them in config values as `${{KEY}}`.

Security policy is the JSON in `agents.security_json`:

```json
{
  "autonomy_level": "supervised",
  "require_approval_for": ["exec"],
  "access": "protected",
  "access_token": "<token>"
}
```

## API

Core routes:

- `POST /api/agents/{id}/sessions`
- `GET /api/agents/{id}/sessions`
- `POST /api/agents/{id}/sessions/{sessionId}/messages`
- `POST /api/agents/{id}/sessions/{sessionId}/messages?wait=true`
- `POST /api/agents/{id}/sessions/{sessionId}/messages?stream=true`
- `GET /api/agents/{id}/sessions/{sessionId}/events`
- `ws://host/api/agents/{id}/ws`

Example:

```bash
curl -X POST 'http://127.0.0.1:4000/api/agents/main/sessions/cli%3Adefault/messages?wait=true' \
  -H "authorization: Bearer $OPENHERMIT_TOKEN" \
  -H "content-type: application/json" \
  -d '{"text":"Hello"}'
```

## Internal State

PostgreSQL stores agents, sessions, events, memories, instructions, users, sandboxes, skills, MCP servers, schedules, and schedule runs.

The only per-agent files on disk are the workspace under `~/.openhermit/workspaces/{agentId}/`; enabled skills are synced into each backend's own `<agent_home>/.openhermit/skills/system/`.

## Development

```bash
npm run dev:gateway
npm run dev:web
npm run dev:cli
npm run dev:studio
npm run typecheck
npm test
```
