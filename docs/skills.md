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
| `GET` | `/api/admin/skills/scan` | scan the gateway skills directory for manifests — read-only, does not touch the DB or blob storage |
| `GET` | `/api/admin/skills/assignments` | list skill assignments |
| `GET` | `/api/admin/skills/{id}` | get one skill |
| `POST` | `/api/admin/skills` | create or upsert a skill (content-only — see [Register vs. sync](#register-vs-sync)) |
| `POST` | `/api/admin/skills/sync` | re-read `SKILL.md` frontmatter into the DB and re-copy sandbox mounts; body `{ "id": "..." }` targets one skill, otherwise all system skills |
| `DELETE` | `/api/admin/skills/{id}` | delete a skill — refuses while it is still enabled for any agent (see [Deleting a skill](#deleting-a-skill)) |
| `POST` | `/api/admin/skills/{id}/enable` | enable for `agentId` or global `*` |
| `POST` | `/api/admin/skills/{id}/disable` | disable for `agentId` or global `*` |
| `POST` | `/api/admin/skills/migrate-blob` | one-shot: pack legacy bare-path skills into blob storage; dry run unless `{ "apply": true }` |

### Register vs. sync

`POST /api/admin/skills` is **content-only**: it publishes the skill directory
to blob storage and writes the `name` and `description` **exactly as supplied in
the request body** — the server never opens `SKILL.md`. (`hermit skills register`
is a thin client over it: it reads the frontmatter *once*, locally, to default
`--name`/`--description`, then posts them.) Either way, re-registering a skill
whose frontmatter later changed — without passing the new values — leaves the DB
index stale.

`POST /api/admin/skills/sync` (`hermit skills sync [skillId]`) is what
reconciles the index with the files. For each **system** skill it re-reads
`SKILL.md` frontmatter from wherever the row's `path` points (materializing a
`blob:` pointer first, or reading a legacy bare path off disk) and updates the
DB `name`/`description` to match. It reports one action per skill —
`updated` (with a `changes` diff), `unchanged`, `missing_on_disk`, or
`not_registered`. Regardless of whether any frontmatter changed, it then
re-copies the skill directories into every running agent's sandbox, since the
`SKILL.md` body and helper scripts can change with no frontmatter diff. Sync
only applies to system skills; targeting a user skill is rejected.

### Deleting a skill

`DELETE /api/admin/skills/{id}` (`hermit skills delete`) is idempotent —
deleting an unknown id returns `{ ok: true, deleted: false }`. It **refuses**
(validation error) while the skill is still enabled for any agent, naming the
offending assignments, and tells the operator to disable it there first.
Disabling is what unmounts the skill from a sandbox (immediately for a running
sandbox, on next hydrate for a paused one), so by delete time the sandbox side
is already handled. Once no enabled assignment remains, the delete cascades the
leftover disabled `agent_skills` rows together with the `skills` row in one
transaction, then best-effort removes the blob archive (a leaked blob is
recoverable; a row pointing at a missing blob is not).

## Agent API

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/agents/{agentId}/skills` | list effective skills |
| `POST` | `/api/agents/{agentId}/skills/{skillId}/enable` | enable for agent |
| `POST` | `/api/agents/{agentId}/skills/{skillId}/disable` | disable for agent |

These routes require owner or admin auth.

## CLI

`hermit skills` wraps the routes above:

| Command | Description |
|---------|-------------|
| `hermit skills list` | list registered skills |
| `hermit skills assignments` | show which skills are enabled for which agents |
| `hermit skills scan` | preview the manifests in the gateway skills directory — read-only; registers nothing and uploads nothing. Blob upload happens only at `register`. |
| `hermit skills register <id> --path <dir> [--name ...] [--description ...]` | register/upsert a skill from a local directory; `--name`/`--description` default to the directory's `SKILL.md` frontmatter, read once at register time |
| `hermit skills sync [skillId]` | re-read `SKILL.md` and refresh the DB index + running agents; one skill if an id is given, otherwise every system skill |
| `hermit skills enable <id> (--agent <id> \| --all)` | enable for one agent or every agent (`*`) |
| `hermit skills disable <id> (--agent <id> \| --all)` | disable for one agent or every agent (`*`) |
| `hermit skills delete <id>` | delete a skill (disable it everywhere first — see [Deleting a skill](#deleting-a-skill)) |

`register` fills `name`/`description` from frontmatter only at the moment you
run it; it does not track later edits to `SKILL.md`. Run `hermit skills sync`
after changing a skill's frontmatter, body, or helper scripts to push the
change into the DB index and running sandboxes.

## Built-In Skills

Current repository skills:

- `openhermit-admin`
- `openhermit-guide`
- `skill-creator`

See [../skills/](../skills/).
