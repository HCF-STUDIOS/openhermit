# Skills

Skills are prompt-based procedures. A skill is a directory with a required `SKILL.md` frontmatter file and optional scripts, references, templates, or assets.

## Skill Shape

```text
skill-id/
  SKILL.md
  scripts/
  references/
  templates/
```

`SKILL.md` frontmatter:

```yaml
---
name: deploy-staging
description: Build, test, and deploy the current project to staging.
---
```

The name and description form the always-visible skill index. The full body is read only when the agent needs the skill.

## Sources

| Source | Location | Where the agent sees it |
|--------|----------|-------------------------|
| Built-in / platform | host path registered in `skills` table | `<agent_home>/.openhermit/skills/system/{id}` (synced by the backend) |
| Per-agent assignment | same skill library, assigned in `agent_skills` | `<agent_home>/.openhermit/skills/system/{id}` (synced by the backend) |
| Workspace-installed | `<workspace>/.openhermit/skills/{id}` (under the workspace dir, not `system/`) | normal workspace files |

The gateway scans repository `skills/` at startup and upserts those built-ins into the DB when `skillStore` is available.

## Database

| Table | Purpose |
|-------|---------|
| `skills` | id, name, description, host path, metadata |
| `agent_skills` | assignment by `agent_id` or global `*` |

## Runtime Loading

When a runner hydrates (on the first request that targets the agent, or on `agents restart`):

1. DB-managed enabled skills are resolved for the agent, including global `*` assignments.
2. The gateway calls `runner.syncSkills`, which dispatches to each `ExecBackend`:
   - **docker** — bind-mounts the workspace's `.openhermit/skills/system/` into the container
   - **host** — writes into `$HOME/.openhermit/skills/system/`
   - **e2b** / **daytona** — uploads files via SDK to `<agent_home>/.openhermit/skills/system/`
3. The agent scans DB skills and workspace skills.
4. Prompt assembly includes the skill index.

DB skills take precedence over workspace-installed skills with the same name.

## Admin API

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/admin/skills` | list registered skills |
| `GET` | `/api/admin/skills/scan` | scan skill directories |
| `GET` | `/api/admin/skills/assignments` | list skill assignments |
| `GET` | `/api/admin/skills/{id}` | get one skill |
| `POST` | `/api/admin/skills` | create or upsert a skill |
| `DELETE` | `/api/admin/skills/{id}` | delete a skill |
| `POST` | `/api/admin/skills/{id}/enable` | enable for `agentId` or global `*` |
| `POST` | `/api/admin/skills/{id}/disable` | disable for `agentId` or global `*` |

## Agent API

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/agents/{agentId}/skills` | list effective skills |
| `POST` | `/api/agents/{agentId}/skills/{skillId}/enable` | enable for agent |
| `POST` | `/api/agents/{agentId}/skills/{skillId}/disable` | disable for agent |

These routes require owner or admin auth.

## Built-In Skills

Current repository skills:

- `openhermit-usage`
- `skill-creator`

See [../skills/](../skills/).
