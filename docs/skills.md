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

### Staging and paused/cold sandboxes

A skill row's `path` is a `blob:` pointer, so `runner.syncSkills` unpacks the
artifacts into a temp directory and deletes it as soon as the call returns. The
remote backends (e2b / daytona / tenki) therefore treat `sourcePath` as
ephemeral and never persist it:

- A sync that arrives while the sandbox is paused or cold cannot upload, so the
  backend only records a bare dirty flag (`pending_sync_skills`) in runtime
  state — never the skill list or the staging path (both long gone by wake-up).
  On the next `ensure()` the enabled system skills are re-derived from the DB and
  re-materialized, then the flag is cleared.
- A fresh sandbox always reconciles from the DB (it starts empty); a resumed one
  reconciles only when the dirty flag is set.
- Before the destructive prepare step runs, every install source is checked
  (`assertSkillSourcesReadable`); a sync that cannot read its source fails
  without emptying the skill directory. Because the plan reinstalls every enabled
  skill rather than a diff, the next successful sync repairs a sandbox left
  inconsistent by an earlier failure.

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

- `openhermit-admin`
- `openhermit-guide`
- `skill-creator`

See [../skills/](../skills/).
