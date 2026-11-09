# Filesystem Tools

> **Status: implemented.** See `apps/agent/src/tools/file.ts` for the tool definitions and `apps/agent/src/core/exec-backend.ts` for the `FileBackend` implementations. This document was the original design proposal; the sections below now describe the shipped behavior.

Today an agent reads and writes files by spawning shell commands through `exec` (`cat`, `tee`, `grep`, redirection). That works but makes path-level access policy impossible: by the time the gateway sees a shell string, it can't reliably tell which paths will be touched. To enforce per-path grants we need first-class file tools whose arguments are paths, not shell strings.

This document proposes those tools and the backend abstraction behind them.

## Goals

- Path-level access policy enforceable at the tool layer.
- Uniform tool surface across `docker` / `e2b` / `daytona` backends.
- Multi-sandbox aware: an agent can own several sandboxes; tool calls and policies must distinguish them.
- Performance comparable to direct `cat` / `tee`.

## Non-goals

- Replacing `exec` for general shell tasks. `exec` stays, with its own (typically owner-only) policy.
- Ensuring exec cannot read sensitive files. Defence-in-depth across exec and fs tools is the access-policy layer's job, not the fs layer's.
- A general POSIX surface. We expose just what agents actually need.

## Tool surface

| Tool | Args | Notes |
|------|------|-------|
| `file_read` | `path`, `sandbox?`, `offset?`, `limit?`, `encoding?` | Line-numbered text by default. `offset` (1-based line) and `limit` (line count) for large files. `encoding=base64` for binary. 5 MiB cap. |
| `file_write` | `path`, `content`, `sandbox?`, `mode?`, `encoding?` | `mode`: `'overwrite'` (default) / `'create'` / `'append'`. Parent dirs created automatically. |
| `file_edit` | `path`, `find_text`, `replace_text`, `sandbox?`, `replace_all?` | Exact-match find-and-replace. Fails if `find_text` not found. |
| `file_list` | `path`, `sandbox?` | Directory listing with type + size. |
| `file_stat` | `path`, `sandbox?` | Existence, type, size, mtime. Returns null if missing. |
| `file_delete` | `path`, `sandbox?` | Single file; no recursive. |

Notably absent: copy, move, chmod, chown, glob. Agents can compose those from the primitives above or use `exec`.

All five tools are **configurable** in the access-policy sense. Defaults:

```
file_read   → grants=[{type:'role', value:'owner'}, {type:'role', value:'user'}]
file_write  → grants=[{type:'role', value:'owner'}]
file_list   → same as file_read
file_stat   → same as file_read
file_delete → same as file_write
```

Agent operators tighten or loosen per agent; per-path grants live in `agent_policies` rows of type `file`.

## Multi-sandbox addressing

An agent can own multiple sandboxes — for example an `ubuntu-primary` docker box for daily work and an `e2b-throwaway` for risky scratch work. Same path string in different sandboxes refers to entirely different bytes.

Two consequences:

1. **Tool calls carry a `sandbox` argument**, not a default. Forcing the agent to name the sandbox keeps it explicit and auditable. The agent learns the sandbox names from its system prompt / context.

2. **Policy rows include a sandbox column**, with `NULL` meaning "any sandbox owned by this agent":

   ```
   (agent_id, sandbox_alias, resource_type, mode, resource_key, grants)
   ```

   - Specific `sandbox_alias` — rule applies only to that sandbox.
   - `NULL` `sandbox_alias` — rule applies across all of the agent's sandboxes (typical for shared conventions like `/workspace/public/`).

   When evaluating, `canAccess` looks up rows for `(agent, this sandbox)` and `(agent, NULL)` and merges them, with sandbox-specific rules taking precedence on conflicts (longest-prefix-wins still applies within each set).

The `sandbox_alias` column is added to `agent_policies` for this purpose. For non-file resource types it's always `NULL`.

## Backend abstraction

Each `ExecBackend` exposes a `files: FileBackend` property:

```ts
interface FileBackend {
  read(path: string): Promise<FileReadResult>;
  write(path: string, data: Buffer, mode: FileWriteMode): Promise<void>;
  list(path: string): Promise<DirEntry[]>;
  stat(path: string): Promise<FileStat | null>;
  delete(path: string): Promise<void>;
}
```

The backend is scoped to a single sandbox — paths are relative to that sandbox's filesystem. Tool handlers resolve the backend via `context.execBackendManager.get(alias)` and call `backend.files.*`.

### `e2b` backend

`E2BFileBackend` wraps the e2b SDK's filesystem methods (`sandbox.files.read` / `write` / `list` / `getInfo` / `remove` / `exists`). Uses a lazy sandbox reference — the `sandbox` handle is injected after `ensure()` and cleared on `shutdown()`.

### `daytona` backend

`DaytonaFileBackend` wraps the daytona SDK's file APIs (`sandbox.fs.downloadFile` / `uploadFile` / `listFiles` / `getFileDetails` / `deleteFile`). Same lazy-reference pattern as e2b.

### `docker` backend

This is the interesting case. Docker has no clean "read this file" API; the options are `docker cp`, the archive HTTP endpoint (tar streaming), `docker exec cat`, or a host bind-mount. We choose **bind-mount**.

#### Bind-mount design

The docker backend uses `HostFileBackend` with path translation. The gateway's `workspaceDir` (host path) is bind-mounted into the container at `agentHome`. `HostFileBackend` translates agent-visible paths (container root) to host-side paths before issuing `fs` syscalls, and enforces a boundary check to prevent path traversal escape.

#### Path translation

`HostFileBackend` is constructed with `(hostRoot, containerRoot)`:
- Agents always use container-side paths (e.g. `/home/agent/workspace/foo.txt`)
- The backend strips `containerRoot` and prepends `hostRoot` to get the host path
- `realpath` + startsWith boundary check prevents escape via `..` or symlinks
- When `hostRoot === containerRoot`, translation is a no-op but the boundary check still applies

## exec coexistence

The fs tools enforce path policy. `exec` does not — it runs an opaque shell command. So:

- `exec` policy must remain restrictive by default (owner-only is the recommended default in access-policy.md).
- For non-owner roles to do anything meaningful with files, they go through fs tools, which are the gated path.
- Owners who can call `exec` are trusted to read and write directly via shell; the policy model treats that as deliberate.

Without that pairing, fs path policy is theatre — anyone with `exec` access bypasses it. The two layers are designed together.

## Resolved design decisions

1. **Workspace path.** Each backend uses its own `agentHome` / `containerRoot`; no forced convention. `HostFileBackend` translates between the two via path mapping.
2. **Symlink handling.** `realpath` + boundary check — symlinks are resolved and re-checked against the workspace root to prevent escape.
3. **Size limits.** `file_read` caps at 5 MiB. For large files, agents use `offset` (1-based line) and `limit` (line count) to read ranges.
4. **Write atomicity.** Direct `writeFile` (no temp+rename) — atomic rename fails on docker bind-mounts where the gateway UID differs from the container UID.
